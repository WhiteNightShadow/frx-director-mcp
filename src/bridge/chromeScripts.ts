/**
 * Privileged chrome-context JS payloads executed in the parent process via
 * Marionette WebDriver:ExecuteScript (newSandbox:false). Ported verbatim-equivalent
 * from reverse-lab/_harness/frx_drive.py (JS_SETUP/NAV/RUN/STATE/RUNLOG/STOP).
 *
 * They reach the live parent-process singletons through the importESModule side
 * effect: every importESModule of `resource:///modules/agentsidebar/*.sys.mjs`
 * returns the SAME in-process object the live sidebar UI uses.
 *
 * SITE-AGNOSTIC: these contain zero site logic — only drive + read-state calls.
 */

const MOD = (name: string) =>
  `resource:///modules/agentsidebar/${name}.sys.mjs`;

/**
 * Configure provider/model + disable tool-confirm gating for unattended driving.
 * DELIBERATELY never reads or writes the API key — the user configures the key
 * once in the browser. Returns hasKey as a boolean only (never the key itself).
 */
export const JS_CONFIG = `
const [provider, model, ensureConfirmOff] = arguments;
const { configStore } = ChromeUtils.importESModule(${JSON.stringify(MOD("ConfigStore"))});
if (provider) configStore.setActiveProvider(provider);
const active = configStore.getActiveProvider();
if (model) configStore.setModel(active, model);
if (ensureConfirmOff) configStore.setConfirmTools(false);
return { provider: active,
         model: configStore.getModel(active),
         hasKey: !!configStore.getApiKey(active),
         confirmTools: configStore.getConfirmTools() };
`;

/** Navigate the most-recent browser window's current tab to a URL. */
export const JS_NAV = `
const [url] = arguments;
const win = Services.wm.getMostRecentWindow("navigator:browser");
if (!win) return { ok:false, err:"no browser window" };
win.focus();
win.openTrustedLinkIn(url, "current");
const b = win.gBrowser && win.gBrowser.selectedBrowser;
return { ok:true, url, tab: b && b.currentURI && b.currentURI.spec };
`;

/** Fire ONE agentSession.run (fire-and-forget). Refuses if a turn is in flight. */
export const JS_RUN = `
const [tid, sys, convo, ws, assist, maxRounds] = arguments;
const { agentSession } = ChromeUtils.importESModule(${JSON.stringify(MOD("AgentSession"))});
if (agentSession.isRunning(tid)) return { ok:false, err:"already running", running:true };
agentSession.run(tid, { systemPrompt: sys, convo: convo, confirmMode:false,
  assist: !!assist, maxRounds: maxRounds||80, maxPerTool:40, workspaceRoot: ws||null, win:null });
return { ok:true, started:true, tid };
`;

/** Slim snapshot for polling/streaming (content tail truncated for cheapness). */
export const JS_STATE = `
const [tid] = arguments;
const { agentSession } = ChromeUtils.importESModule(${JSON.stringify(MOD("AgentSession"))});
const st = agentSession.getState(tid);
if (!st) return null;
function slim(steps){
  return (steps||[]).slice(-16).map(function(x){
    return { k:x.kind, n:(x.name||x.tool||null),
             t:String(x.text||x.summary||x.content||"").slice(0,260), ok:x.ok };
  });
}
return { running:!!st.running, settled:!!st.settled,
  error: st.error? String(st.error).slice(0,600):null,
  contentTail:String(st.content||"").slice(-3800),
  nSteps:(st.steps||[]).length, steps:slim(st.steps),
  checkpointSeq: st.checkpointSeq||0,
  pendingConfirm: st.pendingConfirm? String((st.pendingConfirm.call&&st.pendingConfirm.call.name)||"?"):null };
`;

/**
 * FULL (untruncated) final content — used when carrying the worker's stage
 * conclusion into the next turn's convo as the assistant message. Fixes the
 * frx_drive.py contentTail-3800 truncation (critique fix #convo).
 */
export const JS_CONTENT = `
const [tid] = arguments;
const { agentSession } = ChromeUtils.importESModule(${JSON.stringify(MOD("AgentSession"))});
const st = agentSession.getState(tid);
if (!st) return { content:"", running:false, settled:false };
return { content:String(st.content||""), running:!!st.running, settled:!!st.settled };
`;

/** Engine-level run log (diagnostic: detect drift / idle-timeout / finishReason). */
export const JS_RUNLOG = `
const { getRunLog } = ChromeUtils.importESModule(${JSON.stringify(MOD("AgentSession"))});
return getRunLog();
`;

/**
 * Create a REAL thread in ConversationStore (async) so the MCP-driven run shows
 * up in the browser's 会话列表 and can be opened/followed live in the UI.
 * Returns the store-assigned thread id. The script receives a resolve callback
 * as its LAST argument (ExecuteAsyncScript).
 */
export const JS_NEWTHREAD = `
const a = arguments; const cb = a[a.length - 1];
const [title, workspace, mode] = a;
const { conversationStore } = ChromeUtils.importESModule(${JSON.stringify(MOD("ConversationStore"))});
Promise.resolve(conversationStore.createThread(title || "MCP 任务", workspace || null, mode || "assist"))
  .then(function(t){ cb({ ok:true, id: t && t.id }); })
  .catch(function(e){ cb({ ok:false, err: String((e && e.message) || e) }); });
`;

/** Bind the working directory to a store thread (async) so the UI's 📁 bar shows it. */
export const JS_SETWORKSPACE = `
const a = arguments; const cb = a[a.length - 1];
const [tid, workspace] = a;
const { conversationStore } = ChromeUtils.importESModule(${JSON.stringify(MOD("ConversationStore"))});
Promise.resolve(conversationStore.setThreadWorkspace(tid, workspace || null))
  .then(function(){ cb({ ok:true }); })
  .catch(function(e){ cb({ ok:false, err: String((e && e.message) || e) }); });
`;

/** Append a message (user direction / etc.) to a store thread so the UI shows the full convo. */
export const JS_APPEND = `
const a = arguments; const cb = a[a.length - 1];
const [tid, role, content] = a;
const { conversationStore } = ChromeUtils.importESModule(${JSON.stringify(MOD("ConversationStore"))});
Promise.resolve(conversationStore.appendMessage(tid, { role: role, content: content }))
  .then(function(){ cb({ ok:true }); })
  .catch(function(e){ cb({ ok:false, err: String((e && e.message) || e) }); });
`;

/** Abort the current turn. Progress is durable on disk, so stop loses nothing. */
export const JS_STOP = `
const [tid] = arguments;
const { agentSession } = ChromeUtils.importESModule(${JSON.stringify(MOD("AgentSession"))});
agentSession.stop(tid);
return { ok:true, stopped:true, wasRunning: agentSession.isRunning(tid) };
`;

/**
 * Enumerate the worker's browser-side tool catalog (name / description / confirm /
 * param names) for director VISIBILITY only — handlers are never invoked here.
 * Passes proxy stub backends so every tool passes its _need(backends) gate (so we
 * get the FULL declared surface, not just whatever backends happen to be wired),
 * and falls back to declaredToolNames() for the authoritative name list. Defensive
 * against older browser builds that may lack a given export.
 */
export const JS_TOOLS = `
const mod = ChromeUtils.importESModule(${JSON.stringify(MOD("Tools"))});
const stub = function(){ return new Proxy({}, { get: function(){ return function(){}; } }); };
const backends = { page:stub(), code:stub(), net:stub(), scripts:stub(), jsvmp:stub(), workspace:stub() };
let tools = [];
try {
  tools = (mod.createBuiltinTools(backends) || []).map(function(t){
    let params = [];
    try { if (t.parameters && t.parameters.properties) params = Object.keys(t.parameters.properties); } catch (e) {}
    return { name: t.name,
             description: String((t && t.description) || "").slice(0, 300),
             needsConfirm: !!t.needsConfirm,
             params: params };
  });
} catch (e) {}
let declaredNames = [];
try {
  declaredNames = (typeof mod.declaredToolNames === "function")
    ? mod.declaredToolNames()
    : tools.map(function(t){ return t.name; });
} catch (e) {}
return { tools: tools, declaredNames: declaredNames, count: tools.length };
`;

/**
 * Directly dispatch ONE built-in tool (bypassing the DeepSeek worker) and return
 * its envelope. Uses the browser's agentSession.callTool (firefox-reverse v0.20.0+),
 * which dispatches via the SAME live ToolRouter+backends singleton the worker uses,
 * refuses while any session runs (shared page/hook state), and never throws.
 * Defensive: older browser builds lack callTool → return a clear upgrade hint.
 * Async (callTool returns a Promise) → cb as LAST arg.
 */
export const JS_CALLTOOL = `
const a = arguments; const cb = a[a.length - 1];
const [name, args, ws] = a;
const { agentSession } = ChromeUtils.importESModule(${JSON.stringify(MOD("AgentSession"))});
if (typeof agentSession.callTool !== "function") {
  cb({ ok:false, error:"this Firefox-Reverse build has no agentSession.callTool — update to v0.20.0+ to use agent_call_tool" });
} else {
  Promise.resolve(agentSession.callTool(name, args || {}, { workspaceRoot: ws || null }))
    .then(function(env){ cb(env); })
    .catch(function(e){ cb({ ok:false, error: String((e && e.message) || e) }); });
}
`;
