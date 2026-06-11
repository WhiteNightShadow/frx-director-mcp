import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserBridge,
  StateSnap,
  RunParams,
  ConfigResult,
  ToolCatalog,
} from "./BrowserBridge.js";

/**
 * FALLBACK SEAM — file-IPC transport. Node side is implemented (atomic temp+rename
 * command/state files, monotonic seq for dedup). The BROWSER side counterpart —
 * a parent-process `BridgePoll.sys.mjs` that polls the command file, calls
 * agentSession, and writes the state file — is NOT shipped yet.
 *
 * Use only if a future Firefox build breaks the Marionette executeScript→singleton
 * path. Until BridgePoll.sys.mjs lands, connect() throws with that guidance.
 */
export class FileBridge implements BrowserBridge {
  private seq = 0;
  constructor(private dir: string) {}

  async connect(): Promise<void> {
    throw new Error(
      "FileBridge requires a parent-process BridgePoll.sys.mjs in the browser " +
        "(not shipped yet). Use FRX_BRIDGE=marionette. This stub exists as the " +
        "documented fallback seam; the Node side below is ready to pair with it.",
    );
  }

  async close(): Promise<void> {}

  /** Atomic write (temp + rename) so the poller never reads a half-written file. */
  private async send(op: string, args: unknown): Promise<unknown> {
    await mkdir(this.dir, { recursive: true });
    const seq = ++this.seq;
    const cmdPath = join(this.dir, "command.json");
    const tmp = cmdPath + ".tmp";
    await writeFile(tmp, JSON.stringify({ seq, op, args }), "utf8");
    await rename(tmp, cmdPath);
    return this.awaitReply(seq);
  }

  private async awaitReply(seq: number, timeoutMs = 30_000): Promise<unknown> {
    const statePath = join(this.dir, "state.json");
    const t0 = Date.now();
    for (;;) {
      try {
        const s = JSON.parse(await readFile(statePath, "utf8"));
        if (s && s.seq === seq) return s.result;
      } catch {
        /* not written yet */
      }
      if (Date.now() - t0 > timeoutMs) throw new Error("FileBridge reply timeout");
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async config(opts: { provider?: string | null; model?: string | null; ensureConfirmOff?: boolean }): Promise<ConfigResult> {
    return (await this.send("config", opts)) as ConfigResult;
  }
  async navigate(url: string) {
    return (await this.send("navigate", { url })) as { ok: boolean; url?: string; tab?: string; err?: string };
  }
  async newThread(title: string, workspace: string | null, mode: "assist" | "auto") {
    return (await this.send("new-thread", { title, workspace, mode })) as { ok: boolean; id?: string; err?: string };
  }
  async appendMessage(tid: string, role: "user" | "assistant", content: string) {
    return (await this.send("append", { tid, role, content })) as { ok: boolean; err?: string };
  }
  async setThreadWorkspace(tid: string, workspace: string) {
    return (await this.send("set-workspace", { tid, workspace })) as { ok: boolean; err?: string };
  }
  async run(tid: string, p: RunParams) {
    return (await this.send("run", { tid, ...p })) as { ok: boolean; started?: boolean; err?: string; running?: boolean };
  }
  async getState(tid: string): Promise<StateSnap | null> {
    return (await this.send("get-state", { tid })) as StateSnap | null;
  }
  async getContent(tid: string) {
    return (await this.send("get-content", { tid })) as { content: string; running: boolean; settled: boolean };
  }
  async stop(tid: string) {
    return (await this.send("stop", { tid })) as { ok: boolean; stopped: boolean; wasRunning: boolean };
  }
  async runlog(): Promise<unknown[]> {
    const r = await this.send("runlog", {});
    return Array.isArray(r) ? r : [];
  }
  async listTools(): Promise<ToolCatalog> {
    return (await this.send("list-tools", {})) as ToolCatalog;
  }
}
