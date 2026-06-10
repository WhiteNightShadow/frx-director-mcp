import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserBridge, StateSnap } from "./bridge/BrowserBridge.js";
import { SessionManager, type Msg } from "./session.js";
import { TurnLogger } from "./logging.js";
import { waitForStop, type WaitResult } from "./settle.js";
import { buildSystemPrompt } from "./prompt.js";
import type { Config } from "./config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "task"
  );
}

function readFileSafe(p: string, maxChars: number): string | undefined {
  try {
    if (!existsSync(p)) return undefined;
    const s = readFileSync(p, "utf8");
    return s.length > maxChars ? s.slice(0, maxChars) + "\n…(truncated)" : s;
  } catch {
    return undefined;
  }
}

/**
 * Heuristic drift signal (CRITIQUE FIX #3 robustified). In assist mode the engine
 * forces ANY no-tool textual reply to stopReason:"final", so a genuine conclusion
 * and a model-drift "plaintext plan, no tool call" are indistinguishable via
 * getState alone. We flag a likely-drift when the recent step tail is all
 * text/think with zero tool calls, and ALWAYS surface the raw runlog tail so the
 * director can cross-check finishReason before trusting a "route-dead" call.
 */
function driftHint(steps: StateSnap["steps"]): { likelyDrift: boolean; reason: string } {
  const tail = steps.slice(-6);
  if (!tail.length) return { likelyDrift: false, reason: "" };
  const toolsInTail = tail.filter((s) => s.k === "tool").length;
  const lastKind = tail[tail.length - 1]!.k;
  if (toolsInTail === 0 && (lastKind === "text" || lastKind === "think")) {
    return {
      likelyDrift: true,
      reason:
        "末尾若干步全是纯文字/思考、零工具调用 — 可能是模型漂移成纯文字计划（assist 模式下会被强制收成 final）。" +
        "信这个结论前先看 agent_runlog 的 finishReason，别把 drift/idle-timeout 当成真的“路线走不通”。",
    };
  }
  return { likelyDrift: false, reason: "" };
}

export class Director {
  private sessions: SessionManager;
  private log: TurnLogger;

  constructor(
    private bridge: BrowserBridge,
    private cfg: Config,
  ) {
    this.sessions = new SessionManager(cfg.dataDir);
    this.log = new TurnLogger(cfg.dataDir);
  }

  /** Re-poll after fire-and-forget run() to confirm the turn actually started
   *  (CRITIQUE FIX #4 — the re-entrancy guard makes a mistimed run() a silent no-op). */
  private async confirmStarted(tid: string): Promise<boolean> {
    for (let i = 0; i < 8; i++) {
      await sleep(250);
      const st = await this.bridge.getState(tid);
      if (st && (st.running || st.settled || st.nSteps > 0)) return true;
    }
    return false;
  }

  /** Preflight self-check: bridge reachable? active provider/model? worker key configured?
   *  The director should call this FIRST and guide the user per `note` if not ready. */
  async status() {
    try {
      const cfg = await this.bridge.config({ model: null, ensureConfirmOff: false });
      return {
        bridgeConnected: true,
        ready: !!cfg.hasKey,
        provider: cfg.provider,
        model: cfg.model,
        hasKey: cfg.hasKey,
        confirmTools: cfg.confirmTools,
        note: cfg.hasKey
          ? `就绪:浏览器已连、worker provider=${cfg.provider}、model=${cfg.model}。可以直接 agent_start。`
          : `浏览器连上了,但 provider "${cfg.provider}" 没配 API Key —— 请用户在 Firefox Reverse 的 Agent ⚙️ 设置里,给一个便宜 worker 模型(如 qwen-turbo / deepseek-v4-flash / glm)填好 Key。`,
      };
    } catch (e) {
      return {
        bridgeConnected: false,
        ready: false,
        error: String((e as Error)?.message ?? e),
        note:
          "连不上浏览器的 marionette(127.0.0.1:2828)。请用户用 " +
          '`"/Applications/Firefox Reverse.app/Contents/MacOS/firefox" -marionette -remote-allow-system-access -profile "<你的 profile>"` ' +
          "启动 Firefox Reverse(或设 FRX_AUTOLAUNCH=1+FRX_FIREFOX_BIN/FRX_PROFILE 让本 MCP 替你拉起)。",
      };
    }
  }

  async start(args: {
    task: string;
    targetUrl?: string;
    provider?: string;
    model?: string;
    workspaceRoot?: string;
    maxRounds?: number;
    assist?: boolean;
    ensureConfirmOff?: boolean;
  }) {
    const assist = args.assist !== false;
    const model = args.model ?? this.cfg.defaultModel ?? "";

    const cfgRes = await this.bridge.config({
      provider: args.provider || null,
      model: model || null,
      ensureConfirmOff: args.ensureConfirmOff !== false,
    });
    if (!cfgRes.hasKey) {
      throw new Error(
        `当前 provider "${cfgRes.provider}" 没有配置 API key。` +
          "请先在 Firefox Reverse 的 Agent 设置里给这个 provider 填好 key（MCP 不碰 key）。",
      );
    }

    // Create a REAL thread in the browser's ConversationStore so the run is
    // visible in the UI 会话列表 and can be opened/followed live. Fall back to a
    // generated id if the store call fails (engine still runs by tid either way).
    const fallbackTid = `frx-${slug(args.task)}-${Date.now().toString(36)}`;
    const created = await this.bridge
      .newThread(args.task.slice(0, 40), null, assist ? "assist" : "auto")
      .catch(() => null);
    const tid = created && created.ok && created.id ? created.id : fallbackTid;
    this.log.event(tid, "new-thread", created);

    const workspaceRoot = args.workspaceRoot || join(this.cfg.workspaceRoot, tid);
    mkdirSync(workspaceRoot, { recursive: true });
    // Bind the workspace to the store thread so the UI's 📁 bar shows the directory.
    await this.bridge.setThreadWorkspace(tid, workspaceRoot).catch(() => {});

    const s = this.sessions.create(tid, workspaceRoot, assist ? "assist" : "auto", model || null);

    if (args.targetUrl) {
      const nav = await this.bridge.navigate(args.targetUrl);
      this.log.event(tid, "navigate", nav);
    }

    const convo: Msg[] = [{ role: "user", content: args.task }];
    this.sessions.setConvo(tid, convo);
    // Mirror the task into the store thread so the UI shows the opening message.
    await this.bridge.appendMessage(tid, "user", args.task).catch(() => {});
    const sys = buildSystemPrompt(this.cfg.jsxPromptSrc, workspaceRoot, s.mode);
    const r = await this.bridge.run(tid, {
      systemPrompt: sys,
      convo,
      workspaceRoot,
      assist,
      maxRounds: args.maxRounds || 80,
    });
    this.log.event(tid, "run", r);
    const started = r.ok ? await this.confirmStarted(tid) : false;

    return {
      tid,
      workspaceRoot,
      provider: cfgRes.provider,
      model: cfgRes.model,
      hasKey: cfgRes.hasKey,
      mode: s.mode,
      started,
      runResult: r,
      hint: started
        ? "worker 已开始磨。用 agent_wait_for_stop 等阶段门，再 agent_read 看结论。"
        : "run() 未确认启动（可能上一轮还在跑或时序竞争）——用 agent_state 查，必要时 agent_stop 后重试。",
    };
  }

  async waitForStop(args: { tid: string; timeoutSec?: number; intervalSec?: number }): Promise<WaitResult> {
    this.sessions.require(args.tid);
    return waitForStop(this.bridge, args.tid, {
      timeoutSec: args.timeoutSec ?? 5400, // FIX #1: real turns run 20-30+ min
      intervalSec: args.intervalSec ?? 10,
      log: this.log,
    });
  }

  async read(args: { tid: string; includeProgressFile?: boolean; stepTail?: number; contentChars?: number }) {
    const s = this.sessions.require(args.tid);
    const st = await this.bridge.getState(args.tid);
    if (!st) return { tid: args.tid, settled: false, content: "", steps: [], note: "no state — turn never started?" };

    const stepTail = args.stepTail ?? 16;
    const contentChars = args.contentChars ?? 4000;
    const runlog = await this.bridge.runlog().catch(() => []);
    const drift = driftHint(st.steps);

    const out: Record<string, unknown> = {
      tid: args.tid,
      settled: st.settled,
      running: st.running,
      error: st.error,
      checkpointSeq: st.checkpointSeq,
      content: st.contentTail.slice(-contentChars),
      steps: st.steps.slice(-stepTail),
      pendingConfirm: st.pendingConfirm,
      driftHint: drift, // FIX #3
      runlogTail: runlog.slice(-8),
    };
    if (args.includeProgressFile !== false) {
      out.progressMd = readFileSafe(join(s.workspaceRoot, "progress.md"), 8000);
      out.ledgerMd = readFileSafe(join(s.workspaceRoot, "ledger.md"), 8000);
    }
    return out;
  }

  async state(args: { tid: string }) {
    this.sessions.require(args.tid);
    const st = await this.bridge.getState(args.tid);
    if (!st) return { tid: args.tid, running: false, settled: false, nSteps: 0, note: "no state" };
    return {
      tid: args.tid,
      running: st.running,
      settled: st.settled,
      error: st.error,
      nSteps: st.nSteps,
      checkpointSeq: st.checkpointSeq,
      contentTail: st.contentTail.slice(-220),
      pendingConfirm: st.pendingConfirm,
      driftHint: driftHint(st.steps),
    };
  }

  /** The director's core move: carry the worker's conclusion forward + inject guidance + re-run. */
  async send(args: { tid: string; guidance: string; maxRounds?: number; assist?: boolean }) {
    const s = this.sessions.require(args.tid);

    const cur = await this.bridge.getState(args.tid);
    if (cur && cur.running) {
      throw new Error("当前还有一轮在跑（refuse）。先 agent_wait_for_stop 等它停，或 agent_stop 砍掉，再发 guidance。");
    }

    // Carry the FULL final assistant conclusion (untruncated — FIX #convo).
    const full = await this.bridge.getContent(args.tid).catch(() => ({ content: "", running: false, settled: false }));
    let asst = full.content || "";
    const convo = s.convo.slice();
    if (!asst && convo.length && convo[convo.length - 1]!.role === "user") {
      asst = "（上一轮未产出最终文本/已重启浏览器升级工具，进展见工作目录 ledger.md / progress.md）";
    }
    const last = convo[convo.length - 1];
    if (asst && !(last && last.role === "assistant" && last.content === asst)) {
      convo.push({ role: "assistant", content: asst });
    }
    convo.push({ role: "user", content: args.guidance });
    this.sessions.setConvo(args.tid, convo);
    // Mirror the direction into the store thread so the UI shows it live.
    await this.bridge.appendMessage(args.tid, "user", args.guidance).catch(() => {});

    const assist = args.assist ?? s.mode === "assist";
    const seq = convo.filter((m) => m.role === "user").length;
    this.log.guidance(args.tid, seq, args.guidance);

    const sys = buildSystemPrompt(this.cfg.jsxPromptSrc, s.workspaceRoot, assist ? "assist" : "auto");
    const r = await this.bridge.run(args.tid, {
      systemPrompt: sys,
      convo,
      workspaceRoot: s.workspaceRoot,
      assist,
      maxRounds: args.maxRounds || 80,
    });
    this.log.event(args.tid, "advance", r);
    const started = r.ok ? await this.confirmStarted(args.tid) : false;

    return {
      tid: args.tid,
      started,
      convoLen: convo.length,
      assistantCharsCarried: asst.length,
      checkpointWarning: (cur?.checkpointSeq ?? 0) > 0,
      runResult: r,
    };
  }

  async setMode(args: { tid: string; mode: "assist" | "auto" }) {
    this.sessions.setMode(args.tid, args.mode);
    return { tid: args.tid, mode: args.mode };
  }

  async stop(args: { tid: string }) {
    this.sessions.require(args.tid);
    const r = await this.bridge.stop(args.tid);
    this.log.event(args.tid, "stop", r);
    return { tid: args.tid, ...r };
  }

  async runlog(args: { tid?: string }) {
    const all = await this.bridge.runlog();
    const entries = args.tid
      ? all.filter((e) => e && typeof e === "object" && (e as { threadId?: string }).threadId === args.tid)
      : all;
    return { entries: entries.slice(-20), raw: !args.tid };
  }
}
