/** Slim engine snapshot (mirror of JS_STATE). */
export interface StateSnap {
  running: boolean;
  settled: boolean;
  error: string | null;
  contentTail: string;
  nSteps: number;
  steps: Array<{ k: string; n: string | null; t: string; ok?: boolean }>;
  checkpointSeq: number;
  pendingConfirm: string | null;
}

export interface RunParams {
  systemPrompt: string;
  convo: Array<{ role: string; content: string }>;
  workspaceRoot?: string | null;
  assist: boolean;
  maxRounds: number;
}

export interface ConfigResult {
  provider: string;
  model: string;
  hasKey: boolean;
  confirmTools: boolean;
}

/** One browser-side reverse-engineering tool the worker can use. */
export interface ToolInfo {
  name: string;
  description: string;
  needsConfirm: boolean;
  params: string[];
}

/** The worker's tool catalog (surfaced so the director knows the capabilities;
 *  with agent_call_tool 0.2.0+ the director may also dispatch these directly). */
export interface ToolCatalog {
  tools: ToolInfo[];
  /** All declared tool names regardless of which backends are wired (fallback list). */
  declaredNames: string[];
  count: number;
}

/** Envelope returned by a direct tool dispatch (browser-side ToolRouter.dispatch —
 *  never throws; `running` is set when callTool is refused because a session is live). */
export interface ToolEnvelope {
  ok: boolean;
  data?: unknown;
  error?: string;
  meta?: Record<string, unknown>;
  running?: Array<{ id: string; nSteps: number; checkpointSeq: number }>;
}

/**
 * Transport seam between the MCP server and the browser's parent-process
 * agentSession singleton. MarionetteBridge is the proven default; FileBridge is
 * a fallback for if/when the marionette executeScript→singleton path breaks.
 * Swapping transports must not touch tool code.
 */
export interface BrowserBridge {
  connect(): Promise<void>;
  close(): Promise<void>;

  /** Select provider + model + confirm-gating. NEVER touches the API key. */
  config(opts: { provider?: string | null; model?: string | null; ensureConfirmOff?: boolean }): Promise<ConfigResult>;
  navigate(url: string): Promise<{ ok: boolean; url?: string; tab?: string; err?: string }>;

  /** Create a real thread in the browser's ConversationStore (so the UI can list/show it). */
  newThread(title: string, workspace: string | null, mode: "assist" | "auto"): Promise<{ ok: boolean; id?: string; err?: string }>;
  /** Append a message to a store thread (so the UI shows the full conversation). */
  appendMessage(tid: string, role: "user" | "assistant", content: string): Promise<{ ok: boolean; err?: string }>;
  /** Bind the working directory to a store thread (so the UI 📁 bar shows it). */
  setThreadWorkspace(tid: string, workspace: string): Promise<{ ok: boolean; err?: string }>;

  /** Fire-and-forget one turn. */
  run(tid: string, p: RunParams): Promise<{ ok: boolean; started?: boolean; err?: string; running?: boolean }>;
  getState(tid: string): Promise<StateSnap | null>;
  /** Full untruncated final content (for carrying a conclusion into the next convo). */
  getContent(tid: string): Promise<{ content: string; running: boolean; settled: boolean }>;
  stop(tid: string): Promise<{ ok: boolean; stopped: boolean; wasRunning: boolean }>;
  runlog(): Promise<unknown[]>;
  /** Read-only catalog of the browser-side tools the worker can use. */
  listTools(): Promise<ToolCatalog>;
  /** Directly dispatch ONE browser tool, bypassing the worker. Refused while a session runs. */
  callTool(name: string, args: Record<string, unknown>, opts?: { workspaceRoot?: string | null }): Promise<ToolEnvelope>;
}
