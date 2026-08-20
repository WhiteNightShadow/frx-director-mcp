import type {
  BrowserBridge,
  ConfigResult,
  RunParams,
  StateSnap,
  ToolCatalog,
  ToolEnvelope,
} from "./BrowserBridge.js";

/**
 * Registers the MCP surface before environment resolution / browser startup has
 * produced a concrete bridge. Calls fail fast with a useful status until the
 * target is installed; they never hold an MCP request open behind a 60-90s
 * Windows cold start.
 */
export class DeferredBrowserBridge implements BrowserBridge {
  private target: BrowserBridge | null = null;
  private failure = "";

  setTarget(target: BrowserBridge): void {
    if (this.target && this.target !== target) {
      throw new Error("browser bridge target is already set");
    }
    this.target = target;
    this.failure = "";
  }

  setFailure(message: string): void {
    if (!this.target) this.failure = String(message || "browser bridge initialization failed");
  }

  private requireTarget(): BrowserBridge {
    if (this.target) return this.target;
    if (this.failure) throw new Error(this.failure);
    throw new Error("browser bridge is still resolving; call frx_status again shortly");
  }

  connect(): Promise<void> {
    return this.requireTarget().connect();
  }

  async close(): Promise<void> {
    if (this.target) await this.target.close();
  }

  config(opts: { provider?: string | null; model?: string | null; ensureConfirmOff?: boolean }): Promise<ConfigResult> {
    return this.requireTarget().config(opts);
  }

  navigate(url: string): Promise<{ ok: boolean; url?: string; tab?: string; err?: string }> {
    return this.requireTarget().navigate(url);
  }

  newThread(
    title: string,
    workspace: string | null,
    mode: "assist" | "auto",
  ): Promise<{ ok: boolean; id?: string; err?: string }> {
    return this.requireTarget().newThread(title, workspace, mode);
  }

  appendMessage(
    tid: string,
    role: "user" | "assistant",
    content: string,
  ): Promise<{ ok: boolean; err?: string }> {
    return this.requireTarget().appendMessage(tid, role, content);
  }

  setThreadWorkspace(tid: string, workspace: string): Promise<{ ok: boolean; err?: string }> {
    return this.requireTarget().setThreadWorkspace(tid, workspace);
  }

  run(
    tid: string,
    params: RunParams,
  ): Promise<{ ok: boolean; started?: boolean; err?: string; running?: boolean }> {
    return this.requireTarget().run(tid, params);
  }

  getState(tid: string): Promise<StateSnap | null> {
    return this.requireTarget().getState(tid);
  }

  getContent(tid: string): Promise<{ content: string; running: boolean; settled: boolean }> {
    return this.requireTarget().getContent(tid);
  }

  stop(tid: string): Promise<{ ok: boolean; stopped: boolean; wasRunning: boolean }> {
    return this.requireTarget().stop(tid);
  }

  runlog(): Promise<unknown[]> {
    return this.requireTarget().runlog();
  }

  listTools(): Promise<ToolCatalog> {
    return this.requireTarget().listTools();
  }

  callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: { workspaceRoot?: string | null },
  ): Promise<ToolEnvelope> {
    return this.requireTarget().callTool(name, args, opts);
  }
}
