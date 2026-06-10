import { MarionetteWire } from "./marionetteWire.js";
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
} from "./chromeScripts.js";
import type {
  BrowserBridge,
  StateSnap,
  RunParams,
  ConfigResult,
} from "./BrowserBridge.js";

/**
 * The v1 bridge: drives the parent-process agentSession singleton over Marionette
 * (port 2828) via chrome-context ExecuteScript. TS port of frx_drive.py.
 *
 * Requires the browser launched with `-marionette -remote-allow-system-access`
 * (chrome SetContext requires system access). Keep the port loopback-only.
 */
export class MarionetteBridge implements BrowserBridge {
  private wire = new MarionetteWire();
  private connected = false;

  constructor(
    private host: string,
    private port: number,
    private timeoutMs = 180_000,
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.wire.connect(this.host, this.port, this.timeoutMs);
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.wire.close();
  }

  async config(opts: { provider?: string | null; model?: string | null; ensureConfirmOff?: boolean }): Promise<ConfigResult> {
    return (await this.wire.execute(JS_CONFIG, [
      opts.provider || null,
      opts.model || null,
      opts.ensureConfirmOff !== false,
    ])) as ConfigResult;
  }

  async navigate(url: string) {
    return (await this.wire.execute(JS_NAV, [url])) as {
      ok: boolean;
      url?: string;
      tab?: string;
      err?: string;
    };
  }

  async newThread(title: string, workspace: string | null, mode: "assist" | "auto") {
    return (await this.wire.executeAsync(JS_NEWTHREAD, [title, workspace, mode])) as {
      ok: boolean;
      id?: string;
      err?: string;
    };
  }

  async appendMessage(tid: string, role: "user" | "assistant", content: string) {
    return (await this.wire.executeAsync(JS_APPEND, [tid, role, content])) as { ok: boolean; err?: string };
  }

  async setThreadWorkspace(tid: string, workspace: string) {
    return (await this.wire.executeAsync(JS_SETWORKSPACE, [tid, workspace])) as { ok: boolean; err?: string };
  }

  async run(tid: string, p: RunParams) {
    return (await this.wire.execute(JS_RUN, [
      tid,
      p.systemPrompt,
      p.convo,
      p.workspaceRoot || null,
      !!p.assist,
      p.maxRounds || 80,
    ])) as { ok: boolean; started?: boolean; err?: string; running?: boolean };
  }

  async getState(tid: string): Promise<StateSnap | null> {
    return (await this.wire.execute(JS_STATE, [tid])) as StateSnap | null;
  }

  async getContent(tid: string) {
    return (await this.wire.execute(JS_CONTENT, [tid])) as {
      content: string;
      running: boolean;
      settled: boolean;
    };
  }

  async stop(tid: string) {
    return (await this.wire.execute(JS_STOP, [tid])) as {
      ok: boolean;
      stopped: boolean;
      wasRunning: boolean;
    };
  }

  async runlog(): Promise<unknown[]> {
    const r = await this.wire.execute(JS_RUNLOG, []);
    return Array.isArray(r) ? r : [];
  }
}
