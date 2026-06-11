import { join } from "node:path";
import { homedir } from "node:os";
import { MarionetteWire, MarionetteError } from "./marionetteWire.js";
import { MarionetteLock } from "./marionetteLock.js";
import {
  JS_CONFIG,
  JS_NAV,
  JS_RUN,
  JS_STATE,
  JS_CONTENT,
  JS_RUNLOG,
  JS_STOP,
  JS_NEWTHREAD,
  JS_APPEND,
  JS_SETWORKSPACE,
  JS_TOOLS,
} from "./chromeScripts.js";
import type {
  BrowserBridge,
  StateSnap,
  RunParams,
  ConfigResult,
  ToolCatalog,
} from "./BrowserBridge.js";

/** How long connect() waits for the cross-process Marionette lock before giving
 *  up and surfacing a clear "another session owns the browser" error. Kept short
 *  so a degraded session never hangs; the owner may hold it for its whole
 *  lifetime and hands off cleanly on exit. */
const LOCK_WAIT_MS = 4000;

/** A dropped/never-established connection (reconnect+retry) vs. a real Marionette
 *  protocol error (surface as-is — retrying it would just fail again). */
function isConnLost(e: unknown): boolean {
  if (e instanceof MarionetteError) return false;
  const m = (e as Error)?.message || "";
  return /marionette (not connected|closed|socket timeout)|bad marionette frame|ECONNRESET|ECONNREFUSED|EPIPE/i.test(m);
}

/**
 * The v1 bridge: drives the parent-process agentSession singleton over Marionette
 * (port 2828) via chrome-context ExecuteScript. TS port of frx_drive.py.
 *
 * Requires the browser launched with `-marionette -remote-allow-system-access`
 * (chrome SetContext requires system access). Keep the port loopback-only.
 *
 * Robustness (2026-06-11): connection is LAZY (only opened on first real use, so
 * idle sessions never contend), arbitrated by a cross-process {@link MarionetteLock}
 * (one owner at a time — no more slot-stealing between sessions), and self-healing
 * (a dropped socket is reconnected + retried ONCE per call, keeping ownership).
 */
export class MarionetteBridge implements BrowserBridge {
  private wire: MarionetteWire | null = null;
  private lock: MarionetteLock;
  private connecting: Promise<void> | null = null;

  constructor(
    private host: string,
    private port: number,
    private timeoutMs = 180_000,
  ) {
    const lockPath = join(homedir(), ".frx-director-mcp", `marionette-${host}-${port}.lock`);
    this.lock = new MarionetteLock(lockPath, { pid: process.pid, ppid: process.ppid, host, port });
  }

  private isLive(): boolean {
    return !!this.wire && this.wire.isConnected();
  }

  /** Ensure a live connection (acquiring the lock if we don't own it). Single-flight
   *  so concurrent callers share one in-progress connect. */
  async connect(): Promise<void> {
    if (this.isLive()) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    if (!this.lock.isHeld()) {
      const got = await this.lock.acquire(LOCK_WAIT_MS);
      if (!got) {
        const h = this.lock.currentHolder();
        throw new Error(
          `另一个 frx-director 会话正持有浏览器 Marionette 连接（PID ${h?.pid ?? "?"}）。` +
            "Marionette 是单客户端:请关掉那个会话、或等它结束后重试(它退出时会自动让出锁)。",
        );
      }
    }
    const w = new MarionetteWire();
    try {
      await w.connect(this.host, this.port, this.timeoutMs);
    } catch (e) {
      // Couldn't actually connect — never squat on the lock (else an owner that
      // can't reach Firefox would block every other session indefinitely).
      this.lock.release();
      throw e;
    }
    this.wire = w;
  }

  async close(): Promise<void> {
    const w = this.wire;
    this.wire = null;
    if (w) {
      try {
        await w.close();
      } catch {
        /* ignore */
      }
    }
    this.lock.release();
  }

  /**
   * Every browser op funnels through here. Two explicit phases:
   *  1. connect lazily (via the lock) then run; a CONNECT failure (degraded lock,
   *     Firefox down) propagates as-is — retrying connect would just fail again.
   *  2. only if the op itself drops the socket mid-flight (isConnLost, not a real
   *     MarionetteError) do we discard the dead wire, reconnect ONCE, and retry the
   *     op ONCE. A second failure propagates. Each success renews the lock lease.
   */
  private async exec<T>(fn: (w: MarionetteWire) => Promise<T>): Promise<T> {
    await this.connect();
    const w1 = this.wire;
    if (!w1) throw new Error("marionette not connected");
    try {
      const r = await fn(w1);
      this.lock.renew();
      return r;
    } catch (e) {
      if (!isConnLost(e)) throw e; // real protocol/app error — surface it
      this.wire = null; // dead wire already tore down its own socket in fail()
      await this.connect();
      const w2 = this.wire;
      if (!w2) throw new Error("marionette not connected");
      const r = await fn(w2);
      this.lock.renew();
      return r;
    }
  }

  async config(opts: { provider?: string | null; model?: string | null; ensureConfirmOff?: boolean }): Promise<ConfigResult> {
    return (await this.exec((w) =>
      w.execute(JS_CONFIG, [opts.provider || null, opts.model || null, opts.ensureConfirmOff !== false]),
    )) as ConfigResult;
  }

  async navigate(url: string) {
    return (await this.exec((w) => w.execute(JS_NAV, [url]))) as {
      ok: boolean;
      url?: string;
      tab?: string;
      err?: string;
    };
  }

  async newThread(title: string, workspace: string | null, mode: "assist" | "auto") {
    return (await this.exec((w) => w.executeAsync(JS_NEWTHREAD, [title, workspace, mode]))) as {
      ok: boolean;
      id?: string;
      err?: string;
    };
  }

  async appendMessage(tid: string, role: "user" | "assistant", content: string) {
    return (await this.exec((w) => w.executeAsync(JS_APPEND, [tid, role, content]))) as { ok: boolean; err?: string };
  }

  async setThreadWorkspace(tid: string, workspace: string) {
    return (await this.exec((w) => w.executeAsync(JS_SETWORKSPACE, [tid, workspace]))) as { ok: boolean; err?: string };
  }

  async run(tid: string, p: RunParams) {
    return (await this.exec((w) =>
      w.execute(JS_RUN, [tid, p.systemPrompt, p.convo, p.workspaceRoot || null, !!p.assist, p.maxRounds || 80]),
    )) as { ok: boolean; started?: boolean; err?: string; running?: boolean };
  }

  async getState(tid: string): Promise<StateSnap | null> {
    return (await this.exec((w) => w.execute(JS_STATE, [tid]))) as StateSnap | null;
  }

  async getContent(tid: string) {
    return (await this.exec((w) => w.execute(JS_CONTENT, [tid]))) as {
      content: string;
      running: boolean;
      settled: boolean;
    };
  }

  async stop(tid: string) {
    return (await this.exec((w) => w.execute(JS_STOP, [tid]))) as {
      ok: boolean;
      stopped: boolean;
      wasRunning: boolean;
    };
  }

  async runlog(): Promise<unknown[]> {
    const r = await this.exec((w) => w.execute(JS_RUNLOG, []));
    return Array.isArray(r) ? r : [];
  }

  async listTools(): Promise<ToolCatalog> {
    const r = (await this.exec((w) => w.execute(JS_TOOLS, []))) as Partial<ToolCatalog> | null;
    const tools = Array.isArray(r?.tools) ? r!.tools : [];
    const declaredNames = Array.isArray(r?.declaredNames) ? r!.declaredNames : [];
    return { tools, declaredNames, count: typeof r?.count === "number" ? r!.count : tools.length };
  }
}
