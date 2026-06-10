import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Director } from "../src/director.js";
import type { BrowserBridge, StateSnap } from "../src/bridge/BrowserBridge.js";
import type { Config } from "../src/config.js";

/** In-memory bridge to exercise the director loop without a real Firefox. */
class MockBridge implements BrowserBridge {
  states = new Map<string, StateSnap>();
  contents = new Map<string, string>();
  runs: Array<{ tid: string; convoLen: number }> = [];
  hasKey = true;

  async connect() {}
  async close() {}
  async config() {
    return { provider: "deepseek", model: "deepseek-v4-flash", hasKey: this.hasKey, confirmTools: false };
  }
  async navigate(url: string) {
    return { ok: true, url };
  }
  threadSeq = 0;
  async newThread(_title: string, _workspace: string | null, _mode: "assist" | "auto") {
    return { ok: true, id: "tmk" + ++this.threadSeq };
  }
  async appendMessage(_tid: string, _role: "user" | "assistant", _content: string) {
    return { ok: true };
  }
  async setThreadWorkspace(_tid: string, _workspace: string) {
    return { ok: true };
  }
  async run(tid: string, p: { convo: unknown[] }) {
    this.runs.push({ tid, convoLen: p.convo.length });
    this.states.set(tid, {
      running: true,
      settled: false,
      error: null,
      contentTail: "",
      nSteps: 1,
      steps: [{ k: "tool", n: "code_search", t: "x", ok: true }],
      checkpointSeq: 0,
      pendingConfirm: null,
    });
    return { ok: true, started: true, tid };
  }
  async getState(tid: string) {
    return this.states.get(tid) ?? null;
  }
  async getContent(tid: string) {
    const s = this.states.get(tid);
    return { content: this.contents.get(tid) ?? "", running: s?.running ?? false, settled: s?.settled ?? false };
  }
  async stop(tid: string) {
    const s = this.states.get(tid);
    const was = !!s?.running;
    if (s) {
      s.running = false;
      s.settled = true;
    }
    return { ok: true, stopped: true, wasRunning: was };
  }
  async runlog() {
    return [];
  }

  /** test helper: force a settled stage gate with given conclusion + steps. */
  settle(tid: string, content: string, steps?: StateSnap["steps"]) {
    this.states.set(tid, {
      running: false,
      settled: true,
      error: null,
      contentTail: content.slice(-3800),
      nSteps: steps?.length ?? 1,
      steps: steps ?? [{ k: "text", n: null, t: content, ok: true }],
      checkpointSeq: 0,
      pendingConfirm: null,
    });
    this.contents.set(tid, content);
  }
}

function cfg(dir: string): Config {
  return {
    jsxPromptSrc: "",
    defaultModel: "",
    workspaceRoot: join(dir, "ws"),
    dataDir: join(dir, "data"),
  } as unknown as Config;
}

describe("Director loop", () => {
  let bridge: MockBridge;
  let d: Director;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "frx-"));
    bridge = new MockBridge();
    d = new Director(bridge, cfg(dir));
  });

  it("start fires a run and confirms it actually started", async () => {
    const r = await d.start({ task: "还原 X-S 签名" });
    expect(r.tid).toMatch(/^tmk/); // tid 来自 store newThread（真机是 tm… 格式）
    expect(r.started).toBe(true);
    expect(bridge.runs.length).toBe(1);
    expect(r.hasKey).toBe(true);
  });

  it("rejects start when the browser has no key configured", async () => {
    bridge.hasKey = false;
    await expect(d.start({ task: "t" })).rejects.toThrow(/key/i);
  });

  it("waitForStop returns settled ONLY when settled===true", async () => {
    const r = await d.start({ task: "t" });
    bridge.settle(r.tid, "①发现 ②方向 ③推荐", [{ k: "tool", n: "run_node", t: "", ok: true }]);
    const w = await d.waitForStop({ tid: r.tid, intervalSec: 0.2, timeoutSec: 5 });
    expect(w.phase).toBe("settled");
  });

  it("timeout while still running returns phase 'running' (re-inspect), not a failure", async () => {
    const r = await d.start({ task: "t" }); // leaves the turn running
    const w = await d.waitForStop({ tid: r.tid, intervalSec: 0.2, timeoutSec: 0.4 });
    expect(w.phase).toBe("running");
    expect(w.stillGrinding).toBe(true);
  });

  it("send carries the FULL conclusion forward (no 3800 truncation) + appends guidance", async () => {
    const r = await d.start({ task: "t" });
    const longConclusion = "结论A".repeat(2000); // 6000 chars > contentTail cap
    bridge.settle(r.tid, longConclusion);
    const res = await d.send({ tid: r.tid, guidance: "只做第1步,先验证再下一步" });
    expect(res.assistantCharsCarried).toBe(longConclusion.length); // full, not truncated
    expect(res.convoLen).toBe(3); // user(task) + assistant(conclusion) + user(guidance)
    expect(res.started).toBe(true);
  });

  it("send refuses while a turn is still running", async () => {
    const r = await d.start({ task: "t" }); // running
    await expect(d.send({ tid: r.tid, guidance: "x" })).rejects.toThrow(/在跑/);
  });

  it("read flags likely drift when the step tail is all plaintext (no tool)", async () => {
    const r = await d.start({ task: "t" });
    bridge.settle(r.tid, "我打算先提取 vendor 的 bootstrapper…", [{ k: "text", n: null, t: "plan", ok: true }]);
    const rd = (await d.read({ tid: r.tid })) as { driftHint: { likelyDrift: boolean } };
    expect(rd.driftHint.likelyDrift).toBe(true);
  });

  it("set_mode persists assist/auto", async () => {
    const r = await d.start({ task: "t" });
    const m = await d.setMode({ tid: r.tid, mode: "auto" });
    expect(m.mode).toBe("auto");
  });
});
