import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Director } from "./director.js";

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});
const err = (e: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: String((e as Error)?.message ?? e) }, null, 2) }],
  isError: true as const,
});

/**
 * Register the director tools. The cost-split is STRUCTURAL: there is no tool
 * that lets the director run a browser tool itself — the only way to make
 * progress is to delegate to the worker model (agent_start/agent_send) and
 * review its stage conclusions (agent_read). assist mode is the load-bearing gate.
 */
export function registerTools(server: McpServer, director: Director): void {
  server.registerTool(
    "frx_status",
    {
      title: "Preflight: check setup before starting",
      description:
        "★开跑前先调这个自检:浏览器(marionette)连没连、当前 worker provider/model、worker key 配没配。" +
        "没就绪就照返回的 note 一句话引导用户(启动浏览器加 marionette / 在浏览器设置里配便宜 worker 模型的 Key),就绪了再 agent_start。只读、无副作用。",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await director.status());
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "agent_start",
    {
      title: "Start a worker session",
      description:
        "开一个新的逆向会话:配置 worker 模型(默认沿用浏览器里已配的)+关掉工具确认门、(可选)导航到目标 URL、建工作目录、用便宜的 worker 模型以【AI 辅助模式】发出第一轮(task 作为第 0 条 user)。返回 tid,后续都用它。" +
        "绝不读/写 worker 的 key——key 由用户预先在浏览器里配好;这里只校验 hasKey=true。worker 选标准/快档别选推理档(推理档在长工具循环里易漂移成纯文字),如 deepseek-v4-flash / qwen-turbo / glm。",
      inputSchema: {
        task: z.string().describe("逆向目标(成为 convo[0] 的 user 内容),例如:还原 xxx.com 的 X-S 签名并 Node 实打接口"),
        targetUrl: z.string().optional().describe("开跑前把当前 tab 导航到这个 URL"),
        provider: z.string().optional().describe("切到这个 provider 再跑(如 deepseek/zhipu/custom),省略=沿用浏览器当前 active。不碰 key,只校验该 provider 的 hasKey"),
        model: z.string().optional().describe("worker 模型名(省略=沿用浏览器配置)。flash 档,如 deepseek-v4-flash(中转)/deepseek-chat(直连)"),
        workspaceRoot: z.string().optional().describe("工作目录绝对路径(省略=在 FRX_WORKSPACE_ROOT 下自动建一个)"),
        maxRounds: z.number().optional().describe("单轮最大工具回合,默认 80"),
        assist: z.boolean().optional().describe("默认 true=阶段门停。false=全自动"),
        ensureConfirmOff: z.boolean().optional().describe("默认 true=关掉工具确认门(无人值守必需)"),
      },
    },
    async (a) => {
      try {
        return ok(await director.start(a));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "agent_wait_for_stop",
    {
      title: "Wait for the worker's stage gate",
      description:
        "阻塞轮询直到 worker 这一轮 settled(阶段门到了)。这是'便宜模型磨完了、该读了'的信号。" +
        "★真实 turn 常 20-30 分钟,默认超时 5400s;★超时但还 running 时返回 phase:'running'(=还在磨、去 agent_read 看看再决定继续等还是 stop+纠正),绝不是'失败'。" +
        "settled 才是唯一的'阶段结束'信号(不靠 nSteps 之类)。",
      inputSchema: {
        tid: z.string(),
        timeoutSec: z.number().optional().describe("默认 5400(=90min)。turn 可能很长,别设太小"),
        intervalSec: z.number().optional().describe("初始轮询间隔秒,默认 10(自动退避到 30)"),
      },
    },
    async (a) => {
      try {
        return ok(await director.waitForStop(a));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "agent_read",
    {
      title: "Read the worker's stage conclusion",
      description:
        "读 worker 的阶段结论(①发现 ②2-3 方向 ③推荐)给 director 评判:含完整 content 尾、步骤尾、工作目录 progress.md/ledger.md(worker 真正依赖的持久知识),以及 ★driftHint + runlogTail——" +
        "assist 模式下任何'纯文字无工具'都被强制成 final,真结论和模型漂移经 getState 分不开,所以读结论时必须看 driftHint/runlog 的 finishReason,别把 drift/idle-timeout 当成真的'路线走不通'(这是 worker 头号失败模式)。只读、可反复调。",
      inputSchema: {
        tid: z.string(),
        includeProgressFile: z.boolean().optional().describe("默认 true=带上 progress.md/ledger.md"),
        stepTail: z.number().optional().describe("回传最近多少步,默认 16"),
        contentChars: z.number().optional().describe("结论文本回传上限,默认 4000"),
      },
    },
    async (a) => {
      try {
        return ok(await director.read(a));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "agent_state",
    {
      title: "Cheap liveness snapshot",
      description:
        "廉价的存活/进度快照(比 agent_read 轻):running/settled/nSteps/checkpointSeq/错误/contentTail 短尾/driftHint。" +
        "用在等待循环里,或发 guidance 前确认上一轮真的停了。注意:健康的 turn 也会几十秒 nSteps 不动(一个长工具/LLM 回合),别据此判'卡死'——唯一可靠的'活着'信号是有没有 settled。",
      inputSchema: { tid: z.string() },
    },
    async (a) => {
      try {
        return ok(await director.state(a));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "agent_send",
    {
      title: "Send a direction correction (the director's core move)",
      description:
        "★director 的核心动作:把方向纠正作为下一条 user 消息发出去并起下一轮(=harness 的 advance)。" +
        "服务端会:把 worker 上一轮的【完整】最终结论作为 assistant 轮接上(上一轮空/被停则合成占位,保证 user/assistant 交替合法)→ 追加你的 guidance 作为新 user 轮 → 持久化 → 以当前模式重跑。" +
        "若还有一轮在跑会拒绝(先 wait 或 stop)。guidance 写得像真人纠正:具体、有序、'只做第 1+2+3 步'、'每步先验证再下一步'、'只回报这 3 件事'、防兔子洞。",
      inputSchema: {
        tid: z.string(),
        guidance: z.string().describe("director 亲笔写的方向纠正/纠矛盾/防绕圈(成为新的 user 轮)"),
        maxRounds: z.number().optional(),
        assist: z.boolean().optional().describe("覆盖本轮模式;省略=沿用会话模式"),
      },
    },
    async (a) => {
      try {
        return ok(await director.send(a));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "agent_set_mode",
    {
      title: "Switch assist/auto",
      description:
        "切会话模式:'assist'=每轮阶段门停给 director review(成本拆分默认);'auto'=worker 跑到完成不停。" +
        "路线锁定后可切 'auto' 让 worker 无人值守收尾,卡住再切回 'assist'。",
      inputSchema: { tid: z.string(), mode: z.enum(["assist", "auto"]) },
    },
    async (a) => {
      try {
        return ok(await director.setMode(a));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "agent_stop",
    {
      title: "Abort the current grind",
      description:
        "砍掉 worker 当前这一轮(agentSession.stop)。用在:读到快照发现 worker 正冲向错误路线,想立刻截停并 agent_send 纠正、不想干等它 settle。进展已落盘(ledger/progress.md),停掉不丢持久状态。",
      inputSchema: { tid: z.string() },
    },
    async (a) => {
      try {
        return ok(await director.stop(a));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "agent_runlog",
    {
      title: "Engine run log (diagnostic)",
      description:
        "引擎级 run 日志(getRunLog):请求/响应时序、重试、idle 看门狗超时、finishReason、drift 检测。诊断用——让 director 区分'worker 真的判定路线走不通' vs '模型侧 drift / idle 超时 / 推理档模型(如 deepseek-v4-pro)吐了纯文字计划没调工具',下结论前先核它。",
      inputSchema: { tid: z.string().optional().describe("省略=全部 run 记录") },
    },
    async (a) => {
      try {
        return ok(await director.runlog(a));
      } catch (e) {
        return err(e);
      }
    },
  );

  server.registerTool(
    "agent_tools",
    {
      title: "List the worker's browser-side tools",
      description:
        "列出浏览器侧 worker 当前可用的逆向工具清单(名称/说明/是否需确认/参数名)——让 director 知道 worker 有哪些能力,好把 guidance 写到点上(指名让它用 signer_trace / jsvmp_trace / page_eval 等)。" +
        "★director 不直接调这些工具(成本拆分:推进只能靠 agent_start / agent_send 委派 worker);本工具只读、无副作用,偶尔参考一次即可。",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await director.tools());
      } catch (e) {
        return err(e);
      }
    },
  );
}
