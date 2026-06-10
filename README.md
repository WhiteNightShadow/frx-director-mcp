# frx-director-mcp

> **TL;DR (EN):** An MCP server that lets a high‑capability *director* model (Claude/GPT) steer the **firefox‑reverse** browser's built‑in Agent (driven by a cheap **worker model** (e.g. DeepSeek / Qwen / GLM), in AI‑assist mode). The director only writes *direction corrections*; the cheap worker does all the tool‑grinding. Same loop you'd run by hand — automated. The MCP server **never touches your API key** (you set that once inside the browser).

让一个**强模型 director**（Claude/GPT）通过 MCP **指挥** firefox‑reverse 浏览器里的内置逆向 Agent（由便宜的 **worker 模型（如 DeepSeek / 通义千问 / GLM）** 在「AI 辅助模式」下实操）。**director 只做方向修正，便宜的 worker 磨所有工具活** —— 把你手动跑的回路自动化。本质是把已在用的 `reverse-lab/_harness/frx_drive.py` 端口成 8 个 MCP 工具，让 director 写 guidance 代替你。

---

## 为什么 / 成本拆分

| | 谁 | 付什么 token |
|---|---|---|
| **磨活**（signer_trace、几百次 run_node 试算法、jsvmp 逐 op、page_eval hook、字节比对…）| 便宜模型（如 DeepSeek-flash / Qwen-turbo / GLM，便宜、量大）| 浏览器引擎里跑，用你**在浏览器配好**的 worker 模型 key |
| **改方向**（读 ~4KB 结论、抓矛盾、纠"路线死"误判、定顺序、补缺失洞见）| Claude/GPT（贵、量小）| 只读结论 + 写一句 guidance |

成本拆分是**结构性**的：8 个工具里**故意没有让 director 自己跑浏览器工具的口子** —— 唯一推进方式就是委派 worker（便宜模型）+ review。`assist:true`（AI 辅助阶段门）是承重机制：强制 worker 每阶段吐一个可 review 的结论，让贵模型在最高杠杆点（早早拦下错路）介入。

## 架构

```
director(Claude/GPT) ──stdio──▶ frx-director-mcp ──TCP 2828──▶ Marionette(chrome 上下文)
                                  │                                  │ ExecuteScript
                                  │ 8 tools                          ▼
                                  │                      importESModule(AgentSession.sys.mjs)
                                  ▼                                  │
                          每 tid 的 convo/turnlog               agentSession 单例(父进程常驻)
                                                                     │ run/getState/stop
                                                                     ▼
                                                        firefox-reverse 内置 Agent(便宜 worker 模型)
                                                        44 个逆向工具 + 工作目录 ledger.md/progress.md
```

## 前置条件

1. **firefox-reverse 浏览器**（"Firefox Reverse.app"），且**已在 Agent 设置里配好 worker 模型的 Key**（如 DeepSeek / 通义千问 / GLM；本 MCP 不碰 key）。worker 建议用**标准/快档**别用**推理档**（推理档在长工具循环里易漂移成纯文字，如用 deepseek-v4-flash / qwen-turbo 而非 -pro）。
2. 浏览器用 **marionette + system access** 启动（chrome 上下文执行特权 JS 必需）：
   ```bash
   "/Applications/Firefox Reverse.app/Contents/MacOS/firefox" \
       -marionette -remote-allow-system-access -profile "<你的 profile>"
   ```
   （或设 `FRX_AUTOLAUNCH=1` + `FRX_FIREFOX_BIN`/`FRX_PROFILE`，让本 server 替你拉起。）
3. Node ≥ 18。

## 安装

```bash
cd frx-director-mcp
npm install
npm run build          # → dist/
cp .env.example .env    # 按注释填 FRX_JSX_PROMPT_SRC 等；key 不用填
npm test               # 可选:跑单测(不需要真浏览器)
```

## 接进 MCP 客户端（director 那侧）

Claude Desktop `claude_desktop_config.json`（或任意 MCP 客户端）：

```jsonc
{
  "mcpServers": {
    "frx-director": {
      "command": "node",
      "args": ["/Users/<you>/Desktop/python_xm/WhiteNightShadowGit/frx-director-mcp/dist/index.js"],
      "env": {
        "FRX_MARIONETTE_PORT": "2828",
        "FRX_JSX_PROMPT_SRC": "/…/firefox-reverse/additions/browser/components/agent-sidebar/content/AgentPanel.jsx",
        "FRX_WORKSPACE_ROOT": "/…/reverse-lab/_ws"
      }
    }
  }
}
```

## 🟢 一键使用：把下面这一整段复制给你的 AI（director）

接好 MCP 后（见上面「安装」+「接进 MCP 客户端」），你**什么都不用懂、不用记命令** —— 把下面这**一整段原样复制**，发给你的 director 模型（Claude / GPT，已连上 `frx-director` 这个 MCP）。它会自己自检环境、缺什么就用一句话引导你补齐，然后自动指挥便宜的 worker 模型把逆向干完。你只需在它问的时候把**目标站**告诉它。

```text
你现在通过一个叫 frx-director 的 MCP,指挥 firefox-reverse 浏览器里的内置逆向 Agent。
你是专业的 Web 端爬虫 / 签名逆向工程师,只负责【方向修正】,不亲自跑浏览器工具——所有工具活由浏览器里那个便宜的 worker 模型磨,你只读它的阶段结论、给方向。成本拆分:你(贵模型)每轮只花很少 token,便宜的 worker 付掉所有 grinding。

【第 0 步 · 自检】先调用 frx_status。
- ready=true → 进入下面流程。
- bridgeConnected=false 或 hasKey=false → 把返回的 note 用一句话告诉我(用户)、让我照着做(用 -marionette 启动浏览器,或在浏览器 Agent 设置里给一个便宜 worker 模型如 qwen-turbo / deepseek-v4-flash 填 Key),我弄好后你再 frx_status 确认,再继续。

【第 1 步 · 要目标】如果我还没给你目标站,就问我要这 4 项:
  ① 站点 URL(能看到目标请求的页面) ② 接口 URL(要复现的请求) ③ 目标参数(要还原的签名/加密参数名) ④ 输出目标(一般是:Node.js 黑盒复刻、脱离浏览器把接口请求成功)。

【第 2 步 · 开跑】agent_start({task:"把上面 4 项拼成清晰任务", targetUrl:"站点 URL"})。返回 tid,后面都用它。
  task 里写清你的判型和方法建议:简单站先 hook 对比标准算法、别硬扣混淆;JSVMP 别逆字节码、走黑盒补环境;别猜函数名,先 signer_trace 抓真实入参。

【第 3 步 · 等 + 读】
  agent_wait_for_stop({tid}) 等它磨到阶段门(可能 10-30 分钟;phase:"running" 只是还在磨、不是失败,继续等或 agent_read 看看)。
  agent_read({tid}) 读阶段结论 + progress.md/ledger.md + driftHint/runlogTail。
  ★信结论前先看 driftHint:别把"模型漂移成纯文字 / idle 超时"当成真的"路线走不通"(worker 头号坑)。

【第 4 步 · 纠方向】agent_send({tid, guidance:"..."}) 写一句具体、有序、防兜圈的纠正,例如:
  "只做第 1+2+3 步"、"每步先验证再下一步"、"先搞定简单的两个、别一头扎进最难的 JSVMP"、"输出对不上是输入没喂对、别去字节级逆向"、"只回报这 3 件事"。
  抓它的自相矛盾(日志显示成功却写失败)、拦下它的臆断(如"换个 bundle 就要换密钥")。

【第 5 步 · 循环】重复 3-4,直到拿到最终可用结果(Node 实打目标接口、返回有效业务数据)。
  路线锁定、只剩机械收尾时可 agent_set_mode({tid, mode:"auto"}) 让 worker 无人值守跑完;卡住再切回 assist。
  看到它冲向错误路线就 agent_stop({tid}) 截停再 agent_send 纠正(进展已落盘,停掉不丢)。

现在开始:先调 frx_status。
```

## 9 个工具（director 可调用）

| 工具 | 作用 |
|---|---|
| `frx_status` | **开跑前先调**：自检浏览器(marionette)连没连 / worker provider·model / key 配没配，没就绪给一句话引导 |
| `agent_start` | 建/选目录 + 选 AI 辅助 + 新会话 + 输目标，一步起跑（校验 hasKey，不碰 key） |
| `agent_wait_for_stop` | 等阶段门 `settled`；超时仍 running → `phase:"running"`（再看，不是失败） |
| `agent_read` | 读阶段结论 + progress.md/ledger.md + **driftHint + runlogTail** |
| `agent_state` | 廉价存活/进度快照 |
| `agent_send` | **director 核心动作**：带上完整结论 + 追加 guidance + 起下一轮 |
| `agent_set_mode` | assist ↔ auto |
| `agent_stop` | 砍掉走错路的当前轮（进展已落盘，不丢） |
| `agent_runlog` | 引擎 run 日志（区分真路线死 vs drift/idle 超时） |

## 已知约束 / 安全

- **桥靠 Marionette executeScript→父进程单例的副作用工作**（harness 用 `newSandbox:false`）。若未来 Firefox build 破了这个把戏，切 `FRX_BRIDGE=file` 用 `FileBridge`（备用 seam，需要浏览器侧 `BridgePoll.sys.mjs`，暂未随浏览器发布）。
- Marionette 端口（2828）**只绑 127.0.0.1**，别对外暴露 —— 它等于把 agentSession（能跑 page_eval/fs 写/run_node）的全权交给能连上端口的人。
- **本 server 绝不读/写/记录 worker 模型的 key**：key 由你在浏览器里配；`agent_start` 只校验 `hasKey` 布尔。turnlog 归档对疑似 key 做硬脱敏。
- 站点无关：本仓只做"驱动 + 读状态"，零站点逻辑/算法。

## 开发

```bash
npm run dev        # tsx 直跑 src/index.ts
npm run typecheck  # tsc --noEmit
npm test           # vitest（mock 桥 + mock marionette server，无需真浏览器）
```

蓝本与依据：`reverse-lab/_harness/frx_drive.py`（8 个工具 1:1 对应其子命令）+ `guidance-*.txt`（director 纠正格式）+ `turnlog-*.ndjson`（getState 快照）。落地相对 frx_drive.py 已修 4 处 evidence-backed 缺陷：超时 1800→5400s 且"超时≠失败"、settle 只认 `settled`、`agent_read` 折进 drift/runlog、fire 后 re‑poll 确认启动。
