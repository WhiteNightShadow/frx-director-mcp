<div align="center">

# frx-director-mcp

**强模型领航 · 低成本实操 —— 浏览器逆向的自动化 MCP**

[![MCP](https://img.shields.io/badge/protocol-MCP-6C4FF7?style=flat-square)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![tests](https://img.shields.io/badge/tests-passing-2EA043?style=flat-square)](#开发)
[![firefox-reverse](https://img.shields.io/badge/for-firefox--reverse-FF7139?style=flat-square&logo=firefoxbrowser&logoColor=white)](https://github.com/WhiteNightShadow/firefox-reverse)

</div>

> **EN — TL;DR:** An MCP server that lets a high‑capability **director** model (Claude / GPT) drive the [firefox‑reverse](https://github.com/WhiteNightShadow/firefox-reverse) browser's built‑in reverse‑engineering Agent. A cheap **worker** model (DeepSeek / Qwen / GLM …) executes all the tooling in the browser's AI‑assist mode; the director only reviews stage conclusions and issues direction. The server **never touches your API key** (configured once inside the browser).

`frx-director-mcp` 是一个 MCP 服务，让**强模型**（Claude / GPT）通过标准 MCP 协议**指挥** [firefox-reverse](https://github.com/WhiteNightShadow/firefox-reverse) 浏览器内置的逆向 Agent：

- **便宜的 worker 模型**（DeepSeek / 通义千问 / GLM 等）在浏览器「AI 辅助」模式下**执行全部工具**（抓包、签名追踪、补环境、脚本验证…）；
- **强模型 director** 只**审阅阶段结论、做方向修正**，不亲自调用工具；
- 二者按 token 成本天然拆分：**强模型的判断力用在最高杠杆点，低成本模型承担全部重复执行**。

服务本身**零站点逻辑、不接触任何 API Key**（Key 仅在浏览器侧配置）。

---

## 目录

[核心理念](#核心理念成本拆分) · [工作流程](#工作流程) · [系统架构](#系统架构) · [快速开始](#快速开始) · [一键使用](#一键使用) · [工具参考](#工具参考) · [安全与约束](#安全与约束) · [开发](#开发)

## 核心理念：成本拆分

| 职责 | 由谁承担 | Token 开销 |
|---|---|---|
| **工具执行** —— signer_trace、批量 run_node 试算法、JSVMP 逐指令、page_eval、字节比对… | 便宜的 worker 模型（DeepSeek-flash / Qwen-turbo / GLM）| 高频、量大；在浏览器引擎内执行，使用你在浏览器中配置的 Key |
| **方向决策** —— 审阅阶段结论、识别矛盾、纠正误判、排定优先级、补充关键洞见 | 强模型 director（Claude / GPT）| 低频、量小；每轮仅读取约数 KB 结论 + 写一条指令 |

成本拆分是**结构性**的：本服务暴露的工具中**刻意不提供让 director 直接操作浏览器的接口** —— 推进的唯一方式，是委派 worker 执行、再审阅其结论。`assist`（AI 辅助阶段门）是承重机制：它强制 worker 在每个阶段产出一份可审阅的结论，使强模型恰好在最高杠杆点（尽早拦截错误路线）介入。

## 工作流程

```
  director (Claude / GPT)                         firefox-reverse 浏览器
  ┌───────────────────────┐    MCP / stdio     ┌──────────────────────────────┐
  │ ① agent_start  下目标  │ ─────────────────▶ │ worker 模型(便宜)执行 44+ 工具 │
  │ ② agent_wait_for_stop │                    │ 抵达阶段门 → 产出阶段结论       │
  │ ③ agent_read   审阅    │ ◀───────────────── │                              │
  │ ④ agent_send   纠方向  │ ─────────────────▶ │ 按新方向继续                  │
  └───────────────────────┘                    └──────────────────────────────┘
        └──────────── 循环 ②~④，直到产出可独立运行的结果 ────────────┘
```

director 每轮只消耗少量 token（读结论 + 写一条方向）；worker 承担全部工具执行。

## 系统架构

```
director (Claude / GPT)
   │  stdio (MCP)
   ▼
frx-director-mcp ──── 9 tools ──── BrowserBridge（Marionette 默认 / File 备用）
   │                                   │  TCP 127.0.0.1:2828 · chrome-context ExecuteScript
   │  每会话 convo / turnlog           ▼
   │                          ChromeUtils.importESModule(AgentSession.sys.mjs)
   ▼                                   │  run / getState / stop
 本地工作目录                agentSession 单例（firefox-reverse 父进程常驻）
                                       ▼
                       内置逆向 Agent（worker 模型）+ 工作目录 ledger.md / progress.md
```

桥接层（`BrowserBridge`）是抽象接口，默认实现走 Marionette；可切换至 `FileBridge` 作为备用通道，工具层无需改动。

## 快速开始

### 前置条件

1. 安装 [firefox-reverse](https://github.com/WhiteNightShadow/firefox-reverse) 浏览器，并在其 Agent 设置中为一个便宜的 worker 模型配置 API Key（DeepSeek / 通义千问 / GLM 等；本服务不接触该 Key）。建议选用**标准 / 快速档**而非推理档 —— 推理档在长工具循环中易退化为纯文本而中断。
2. 以 Marionette + 系统权限启动浏览器（chrome 上下文执行特权 JS 所必需）：
   ```bash
   "/Applications/Firefox Reverse.app/Contents/MacOS/firefox" \
       -marionette -remote-allow-system-access -profile "<你的 profile>"
   ```
   （或配置 `FRX_AUTOLAUNCH=1` 等环境变量，由本服务自动拉起。）
3. Node.js ≥ 18。

### 方式一：让 AI 自动安装（推荐）

在你的 AI 编码工具（Cursor / Claude Code / Codex 等）对话框中输入：

> 帮我安装并配置这个 MCP 工具：**frx-director-mcp**
> 项目地址：https://github.com/WhiteNightShadow/frx-director-mcp

AI 将自动完成 **克隆 → 安装依赖 → 构建 → 写入客户端 MCP 配置** 的全过程。

### 方式二：手动安装

```bash
git clone https://github.com/WhiteNightShadow/frx-director-mcp.git
cd frx-director-mcp
npm install && npm run build      # 产物：dist/index.js
```

将以下条目加入你客户端的 MCP 配置（`<安装路径>` 替换为实际路径）：

<details>
<summary><b>Claude Desktop</b> — <code>~/Library/Application Support/Claude/claude_desktop_config.json</code></summary>

```jsonc
{ "mcpServers": { "frx-director": {
  "command": "node",
  "args": ["<安装路径>/frx-director-mcp/dist/index.js"]
} } }
```
</details>

<details>
<summary><b>Cursor</b> — <code>.cursor/mcp.json</code></summary>

```jsonc
{ "mcpServers": { "frx-director": {
  "command": "node",
  "args": ["<安装路径>/frx-director-mcp/dist/index.js"]
} } }
```
</details>

<details>
<summary><b>Claude Code</b> — 命令行</summary>

```bash
claude mcp add frx-director -- node <安装路径>/frx-director-mcp/dist/index.js
```
</details>

可选环境变量（均有默认值；方式一会由 AI 自动填写，完整说明见 `.env.example`）：

| 变量 | 说明 |
|---|---|
| `FRX_MARIONETTE_PORT` | Marionette 端口，默认 `2828` |
| `FRX_JSX_PROMPT_SRC` | 指向 firefox-reverse 的 `AgentPanel.jsx`，使 director 系统提示与浏览器 UI 同步 |
| `FRX_WORKSPACE_ROOT` | 会话工作目录根，**默认 `~/.frx-director-mcp/workspaces`**（每个会话一个子目录）|
| `FRX_DATA_DIR` | 会话状态（convo / turnlog），**默认 `~/.frx-director-mcp/data`** |
| `FRX_AUTOLAUNCH` + `FRX_FIREFOX_BIN` / `FRX_PROFILE` | 由本服务自动拉起带 Marionette 的浏览器 |

> 📂 **逆向产物在哪里？** 默认每个会话的工作目录是 `~/.frx-director-mcp/workspaces/<会话id>/`（抓取的脚本、还原代码、`ledger.md` / `progress.md` 都落在这里），与你从哪个目录启动无关；`agent_start` / `agent_read` 的返回也会带上该会话的**具体路径**。要改位置，设 `FRX_WORKSPACE_ROOT` 即可。

## 一键使用

安装并接入 MCP 后，**将下面整段原样复制**，作为首条消息发送给你的 director 模型。它会自动完成环境自检、引导你补齐配置、向你询问目标，并自主驱动整个逆向流程 —— 你只需在被询问时提供目标站点。

```text
你现在通过一个叫 frx-director 的 MCP，指挥 firefox-reverse 浏览器里的内置逆向 Agent。
你是专业的 Web 端爬虫 / 签名逆向工程师，只负责【方向决策】，不亲自调用浏览器工具——所有工具执行由浏览器里那个便宜的 worker 模型完成，你只读它的阶段结论、给方向。成本拆分：你（强模型）每轮只花少量 token 审阅结论 + 写一条方向；便宜的 worker 承担全部工具执行。

【第 0 步 · 环境自检】先调用 frx_status。
- ready=true → 进入下面流程。
- bridgeConnected=false 或 hasKey=false → 把返回的 note 用一句话告诉用户、引导其补齐（用 -marionette 启动浏览器，或在浏览器 Agent 设置里为一个便宜 worker 模型如 qwen-turbo / deepseek-v4-flash 配置 Key）；待其完成后再次 frx_status 确认，再继续。

【第 1 步 · 明确目标】若用户尚未提供目标，向其索取以下 4 项：
  ① 站点 URL（能观察到目标请求的页面） ② 接口 URL（要复现的请求） ③ 目标参数（要还原的签名 / 加密参数名） ④ 输出目标（通常为：Node.js 黑盒复刻、脱离浏览器独立请求成功）。

【第 2 步 · 启动】agent_start({task:"将上述 4 项整合为清晰任务", targetUrl:"站点 URL"})；返回 tid，后续均使用它。
  在 task 中给出你的判型与方法建议：简单站点优先 hook 比对标准算法、不必硬扣混淆；JSVMP 不逆字节码、走黑盒补环境；不臆测函数名，先 signer_trace 抓取真实入参。

【第 3 步 · 等待与审阅】
  agent_wait_for_stop({tid}) 等待 worker 抵达阶段门（可能 10–30 分钟；phase:"running" 仅表示仍在执行、并非失败，可继续等待或先 agent_read 查看）。
  agent_read({tid}) 读取阶段结论 + progress.md / ledger.md + driftHint / runlogTail。
  ★采信结论前务必查看 driftHint：勿将「模型漂移为纯文本 / idle 超时」误判为「路线确属不通」（worker 的首要失败模式）。

【第 4 步 · 方向修正】agent_send({tid, guidance:"..."}) 写一条具体、有序、可防止走弯路的指令，例如：
  「仅执行第 1+2+3 步」「每步先验证再进入下一步」「先完成两个简单目标、勿过早深入最难的 JSVMP」「输出不匹配通常是输入未喂对，勿转向字节级逆向」「仅回报这 3 项」。
  同时识别其自相矛盾（日志显示成功却写为失败）、拦截其臆断（如「换一个 bundle 就要换密钥」）。

【第 5 步 · 循环】重复第 3–4 步，直至产出可用结果（Node 独立请求目标接口、返回有效业务数据）。
  当路线已锁定、仅剩机械收尾时，可 agent_set_mode({tid, mode:"auto"}) 让 worker 无人值守完成；若卡住再切回 assist。
  若发现其正驶向错误路线，agent_stop({tid}) 中止后再以 agent_send 修正（进展已持久化，中止不丢失）。

现在开始：先调用 frx_status。
```

## 工具参考

| 工具 | 说明 |
|---|---|
| `frx_status` | **首先调用** —— 自检：Marionette 是否连通、当前 worker provider / model、Key 是否已配置；未就绪时返回引导说明 |
| `agent_start` | 创建会话：绑定工作目录、选择 AI 辅助模式、导航至目标、下达首轮任务（仅校验 `hasKey`，不接触 Key）|
| `agent_wait_for_stop` | 阻塞至 worker 抵达阶段门（`settled`）；超时仍运行则返回 `phase:"running"`（继续等待，非失败）|
| `agent_read` | 读取阶段结论 + `progress.md` / `ledger.md` + `driftHint` / `runlogTail` |
| `agent_state` | 轻量存活 / 进度快照 |
| `agent_send` | **director 核心动作** —— 携带上轮结论、追加方向指令、发起下一轮 |
| `agent_set_mode` | 在 `assist`（逐阶段）与 `auto`（无人值守）之间切换 |
| `agent_stop` | 中止当前轮（进展已持久化至工作目录，不丢失）|
| `agent_runlog` | 引擎级运行日志，用于区分「确属路线不通」与「模型漂移 / idle 超时」|

## 安全与约束

- **不接触 API Key** —— Key 仅在浏览器侧配置；`agent_start` 仅校验 `hasKey` 布尔值；运行日志归档对疑似 Key 做脱敏处理。
- **本地回环** —— Marionette 端口（2828）仅绑定 `127.0.0.1`，请勿对外暴露：能连接该端口者即拥有 `agentSession` 的全部能力（含 `page_eval` / 文件写入 / `run_node`）。
- **站点无关** —— 本服务仅负责「驱动 + 读取状态」，不含任何站点逻辑或算法。
- **桥接机制** —— 经 Marionette 在 chrome 上下文中 `importESModule` 命中父进程单例（`newSandbox:false`）。若未来 Firefox 构建破坏此路径，可切换 `FRX_BRIDGE=file` 使用 `FileBridge` 备用通道。

## 开发

```bash
npm run dev        # tsx 直接运行 src/index.ts
npm run typecheck  # tsc --noEmit
npm test           # vitest（mock 桥接 + mock Marionette 服务，无需真实浏览器）
```

技术栈：TypeScript（strict、NodeNext）+ 官方 `@modelcontextprotocol/sdk`，stdio 传输。源起于实战工具 `frx_drive.py`（经 Marionette 编程驱动 firefox-reverse 内置 Agent），将其子命令封装为标准 MCP 工具，并修复了 4 处经实测验证的缺陷：等待超时上调至 5400s 且「超时 ≠ 失败」、仅以 `settled` 判定阶段结束、`agent_read` 折入 drift / runlog 信号、fire‑and‑forget 后重新轮询确认启动。

## License

本项目为 [firefox-reverse](https://github.com/WhiteNightShadow/firefox-reverse) 的配套工具，遵循同一项目的授权与使用声明 —— 仅供安全研究、接口对接与授权测试，请在合法授权范围内使用。
