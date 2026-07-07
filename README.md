<div align="center">

# frx-director-mcp

**两种模式驱动浏览器逆向 —— ① 强模型领航 · 低模型实操　② 强模型带自建经验库 · 亲自直驱**

[![MCP](https://img.shields.io/badge/protocol-MCP-6C4FF7?style=flat-square)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![tests](https://img.shields.io/badge/tests-passing-2EA043?style=flat-square)](#开发)
[![firefox-reverse](https://img.shields.io/badge/for-firefox--reverse-FF7139?style=flat-square&logo=firefoxbrowser&logoColor=white)](https://github.com/WhiteNightShadow/firefox-reverse)

</div>

> **EN — TL;DR:** An MCP server bridging a high-capability model (Claude / GPT) to the [firefox-reverse](https://github.com/WhiteNightShadow/firefox-reverse) browser's built-in reverse-engineering engine. **Two composable modes:** (1) **Delegate** — the strong model *directs* while a cheap worker (DeepSeek / Qwen / GLM) *executes* all tooling (token cost-split); (2) **Direct-drive** — the strong model uses its *own* skill / experience library and calls the 44 engine tools itself via `agent_call_tool`. It can also list/create/open/import isolated fingerprint environments via `FRX_ENV_ID`. Never touches your API key (configured once in the browser).

`frx-director-mcp` 是一个 MCP 服务，把**强模型**（Claude / GPT）通过标准 MCP 协议接到 [firefox-reverse](https://github.com/WhiteNightShadow/firefox-reverse) 浏览器内置的逆向引擎上。**两种可自由组合的模式：**

- **模式一 · 领航委派（高模型配置、低模型调用）**：强模型当 director 只**下方向、审结论**；**便宜的 worker 模型**（DeepSeek-flash / Qwen-turbo / GLM）在浏览器里**执行全部工具**（抓包、签名追踪、补环境、脚本验证…）。token 天然拆分——强模型的判断力用在最高杠杆点，重复执行交给低成本模型；worker 复用浏览器内置的逆向方法论。
- **模式二 · 经验库直驱（高模型带自建经验库、亲自调用）**：强模型用**自己的经验库 / 技能（skill）/ 方法论**，通过 `agent_call_tool` **亲自直调**浏览器的 44 个核心逆向工具（`signer_trace` / `jsvmp_trace` / `closure_read` / `page_eval` / 引擎级 hook…），跳过 worker。更快更准、可注入你自己的逆向经验；代价是每个工具回合花强模型的 token。

两种模式共用同一套桥接与浏览器引擎，**可按任务、按步自由切换**。0.3.0 起还可通过 MCP 管理 Firefox-Reverse 指纹环境（列表、新建、打开、关闭、导入采集 JSON），用 `FRX_ENV_ID` 启动指定独立 profile。服务本身**零站点逻辑、不接触任何 API Key**（Key 仅在浏览器侧配置）。

---

## 目录

[两种模式](#两种模式) · [工作流程](#工作流程) · [系统架构](#系统架构) · [快速开始](#快速开始) · [一键使用](#一键使用两种模式) · [工具参考](#工具参考) · [安全与约束](#安全与约束) · [开发](#开发)

## 两种模式

| | **模式一 · 领航委派** | **模式二 · 经验库直驱** |
|---|---|---|
| 谁执行工具 | 便宜的 worker 模型（浏览器内） | **强模型自己**（经 MCP 直调） |
| 强模型角色 | 下方向 / 审阶段结论 | 亲自调用每个工具 |
| 经验 / 方法论来源 | 浏览器内置 skill（worker 用） | **强模型自带的经验库 / skill** |
| token 开销 | 低（每轮读结论 + 写一条方向） | 高（每个工具回合都花强模型 token） |
| 适合 | 长任务、省钱、worker 够用 | 强模型本身懂逆向、要更快更准、要带自己的经验库 |
| 关键工具 | `agent_start` / `agent_send` / `agent_read` | `agent_tools` + `agent_call_tool` |

**模式一（默认，省钱主路）** 是结构性的成本拆分：强模型只在最高杠杆点介入，`assist`（AI 辅助阶段门）强制 worker 每阶段产出可审阅结论，让强模型尽早拦截错误路线。

**模式二（0.2.0 起，opt-in 增益）** 把浏览器的 44 个核心工具直接暴露给强模型：先 `agent_tools` 看清能力与参数，再 `agent_call_tool` 亲自直调。强模型可带**自己的逆向经验库 / skill**（例如把一套方法论作为 system prompt），用引擎级工具（页面检测不到）一步步控制浏览器。

> 两者**不是二选一**：可以同一会话里简单步骤亲自 `agent_call_tool` 快跑、繁重重复步骤 `agent_start` 委派 worker。**唯一约束**：同一浏览器同一时刻只跑一种——`agent_call_tool` 在有 worker 会话运行时会被拒绝（与 agent 共享标签页 / hook / trace 状态，并发会串味），先 `agent_stop` / `agent_wait_for_stop` 再直调。

## 工作流程

**模式一 · 领航委派**（强模型下方向、worker 执行）：

```
  强模型 director (Claude / GPT)                  firefox-reverse 浏览器
  ┌───────────────────────┐    MCP / stdio     ┌──────────────────────────────┐
  │ ① agent_start  下目标  │ ─────────────────▶ │ worker 模型(便宜)执行 44 工具 │
  │ ② agent_wait_for_stop │                    │ 抵达阶段门 → 产出阶段结论       │
  │ ③ agent_read   审阅    │ ◀───────────────── │                              │
  │ ④ agent_send   纠方向  │ ─────────────────▶ │ 按新方向继续                  │
  └───────────────────────┘                    └──────────────────────────────┘
        └──────────── 循环 ②~④，直到产出可独立运行的结果 ────────────┘
```
强模型每轮只消耗少量 token（读结论 + 写一条方向）；worker 承担全部工具执行。

**模式二 · 经验库直驱**（强模型带自己的经验库、亲自调每个工具）：

```
  强模型 (Claude + 自建经验库/skill)              firefox-reverse 浏览器
  ┌───────────────────────┐    MCP / stdio     ┌──────────────────────────────┐
  │ ① agent_tools 看能力   │ ─────────────────▶ │ 返回 44 工具的名/参数/说明     │
  │ ② agent_call_tool 直调 │ ─────────────────▶ │ 引擎级 dispatch → 工具信封     │
  │   (signer_trace/       │ ◀───────────────── │ (与内置 Agent 同一套引擎)     │
  │    page_eval/…)        │                    │                              │
  └───────────────────────┘                    └──────────────────────────────┘
        └── 强模型用自己的判断+经验库,逐个工具推进,无需 worker ──┘
```
强模型直接掌舵引擎工具：更快更准、可注入自己的逆向经验；代价是工具回合的 token 由强模型承担。

## 系统架构

```
director (Claude / GPT)
   │  stdio (MCP)
   ▼
frx-director-mcp ──── 21 tools ──── BrowserBridge（Marionette 默认 / File 备用）
   │  模式一: agent_start/send/read…      │  模式二: agent_tools + agent_call_tool
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

1. 安装 [firefox-reverse](https://github.com/WhiteNightShadow/firefox-reverse) 浏览器，并在其 Agent 设置中为一个便宜的 worker 模型配置 API Key（DeepSeek / 通义千问 / GLM 等；本服务不接触该 Key）。

   > 💡 **worker 模型选型（重要）**：走 MCP 驱动这种长工具循环时，**务必选标准 / 快速档**，推荐 **`deepseek-v4-flash`** —— 实测零漂移、约 2–3 分钟/阶段、配合最顺。**切勿用推理档**（如 `deepseek-v4-pro`）：推理档在长工具循环里易退化成「只吐纯文本计划、不再调用工具」而中断，是 worker 的首要失败模式。可在浏览器 Agent 设置里把默认 worker 设为该档，或在 `agent_start({ model: "deepseek-v4-flash" })` 里临时指定（同一个 Key、无需改配置）。
2. 以 Marionette + 系统权限启动浏览器（chrome 上下文执行特权 JS 所必需）。macOS 推荐走 `.app` 的 LaunchServices 启动链路：
   ```bash
   open -n -a "/Applications/Firefox Reverse.app" --args \
       -marionette -remote-allow-system-access -no-remote \
       --marionette-port 2828 -profile "<你的 profile>"
   ```
   Windows / Linux 可直接用 Firefox Reverse 可执行文件带同样参数启动。也可以配置 `FRX_AUTOLAUNCH=1` + `FRX_FIREFOX_BIN` + `FRX_PROFILE`，由本服务自动拉起；macOS 下 `FRX_FIREFOX_BIN` 可指向 `/Applications/Firefox Reverse.app` 或 `.app/Contents/MacOS/firefox`，MCP 会自动转换为 `open -n -a ... --args`。
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
| `FRX_WORKSPACE_ROOT` | 会话工作目录根。**默认放在 firefox-reverse 仓库旁 `…/firefox-reverse-ws`**（从 `FRX_JSX_PROMPT_SRC` 推断仓库位置；推断不出则 `~/firefox-reverse-ws`），每个会话一个子目录 |
| `FRX_DATA_DIR` | MCP 自身状态（convo / turnlog，非逆向产物），**默认 `~/.frx-director-mcp/data`** |
| `FRX_AUTOLAUNCH` + `FRX_FIREFOX_BIN` / `FRX_PROFILE` | 由本服务自动拉起带 Marionette 的浏览器；macOS 自动使用 `.app` 启动，Windows/Linux 直接启动可执行文件 |
| `FRX_ENV_ID` / `FRX_ENVS_ROOT` | 绑定并启动指定 Firefox-Reverse 环境；默认环境根目录为 `~/.firefox-reverse/environments`，未设置 `FRX_ENV_ID` 时沿用 `FRX_PROFILE` 兼容路径 |

> 📂 **逆向产物在哪里？** 工作目录归属 firefox-reverse 项目、而非 MCP 工具自身。默认每个会话的目录是 **`<firefox-reverse 仓库旁>/firefox-reverse-ws/<会话id>/`**（从 `FRX_JSX_PROMPT_SRC` 推断仓库位置；推断不出则 `~/firefox-reverse-ws/<会话id>/`）—— 抓取的脚本、还原代码、`ledger.md` / `progress.md` 都落在这里，与你从哪个目录启动无关；`agent_start` / `agent_read` 的返回也会带上该会话的**具体路径**。要改位置，设 `FRX_WORKSPACE_ROOT` 即可。

## 一键使用（两种模式）

挑一种模式，**将对应整段原样复制**作为首条消息发给你的强模型；它会自动完成环境自检、引导你补齐配置、向你询问目标，并按该模式驱动逆向。

### 模式一 · 领航委派（省 token，worker 干活）

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

### 模式二 · 经验库直驱（强模型亲自调工具，可带你自己的逆向经验库）

> 适合用懂逆向的强模型（如 Claude）+ 你自己的方法论 / skill。把你的**经验库**（一套逆向方法论、站点经验、判型规则…）放在这段之前或作为 system prompt 一并给模型；它将用 `agent_call_tool` 亲自驱动浏览器。

```text
你现在通过一个叫 frx-director 的 MCP，亲自直驱 firefox-reverse 浏览器的逆向引擎工具（直驱模式，不经 worker）。
你是资深 Web 逆向工程师，按【你自己的经验库 / 方法论】判型与决策，并亲手调用浏览器引擎工具完成逆向。

【第 0 步 · 环境自检】先调用 frx_status。bridgeConnected=false → 引导用户用 -marionette 启动浏览器后重试。
  注意：直驱模式只用浏览器引擎工具、不需要 worker 模型的 Key（hasKey=false 也能直驱）。

【第 1 步 · 看清能力】调用 agent_tools，记下 44 个工具的 name 与参数；重点是 16 个引擎级工具
  （signer_trace / jsvmp_trace / closure_read / webapi_trace / whitebox_diff / wasm_probe / crypto_scan 等，页面检测不到）。

【第 2 步 · 明确目标】若用户未给，索取：① 站点 URL ② 接口 URL ③ 目标参数（签名/加密参数名）④ 输出目标（通常 Node 黑盒复刻、脱离浏览器请求成功）。

【第 3 步 · 亲自直驱】用 agent_call_tool({name, args}) 按你的方法论逐步推进，例如：
  - page_navigate 到站点 → net_capture 抓目标请求 → 看签名参数长相判型；
  - 标准算法优先 hook 比对（signer_trace / page_eval 装 hook 记入参出参 → 本地标准库比对），不硬扣混淆；
  - JSVMP 不逆字节码、走黑盒补环境；闭包真值用 closure_read；WASM 用 wasm_probe；
  - run_node 在工作目录里跑复刻、字节级比对自证；fs_write 落产物。
  每次直调读返回信封（ok/data/error），据此决定下一步——这就是你的工具循环。

【约束】① 同一时刻只跑直驱：别再 agent_start 起 worker（会与直调抢同一标签页被拒）。
  ② 最终产物要能脱离浏览器独立运行（Node 补环境/纯算）；浏览器只作分析与验证。

现在开始：先调用 frx_status，再 agent_tools。
```

## 工具参考

**通用**

| 工具 | 说明 |
|---|---|
| `frx_status` | **首先调用** —— 自检：Marionette 是否连通、当前 worker provider / model、Key 是否已配置；未就绪时返回引导说明 |
| `agent_tools` | 列出浏览器侧 44 个工具清单（名称 / 说明 / 是否需确认 / 参数名），含 16 个**引擎级**逆向工具（`signer_trace` / `jsvmp_trace` / `closure_read` / `webapi_trace` / `whitebox_diff` / `wasm_probe`…，页面检测不到）。两种模式都用：委派时照它写 guidance，直驱时照它填 `agent_call_tool` 的参数 |

**指纹环境管理**

| 工具 | 说明 |
|---|---|
| `frx_env_current` / `frx_env_list` | 查看当前连接环境与本机环境列表 |
| `frx_env_create` / `frx_env_rename` | 新建 Chrome-like/Firefox 环境，或重命名已有环境 |
| `frx_env_open` / `frx_env_close` / `frx_env_delete` | 打开、关闭、删除独立 profile + 独立进程环境 |
| `frx_env_import_json` / `frx_env_import_capture` | 导入完整环境 JSON 或外部浏览器采集到的 fingerprint JSON |
| `frx_page_automation_scan` | 扫描当前页常见自动化暴露点，辅助比较手动启动与 MCP 启动差异 |

**模式一 · 领航委派**（强模型下方向，worker 执行）

| 工具 | 说明 |
|---|---|
| `agent_start` | 创建会话：绑定工作目录、选择 AI 辅助模式、导航至目标、下达首轮任务（仅校验 `hasKey`，不接触 Key）|
| `agent_wait_for_stop` | 阻塞至 worker 抵达阶段门（`settled`）；超时仍运行则返回 `phase:"running"`（继续等待，非失败）|
| `agent_read` | 读取阶段结论 + `progress.md` / `ledger.md` + `driftHint` / `runlogTail` |
| `agent_state` | 轻量存活 / 进度快照 |
| `agent_send` | **委派模式核心动作** —— 携带上轮结论、追加方向指令、发起下一轮 |
| `agent_set_mode` | 在 `assist`（逐阶段）与 `auto`（无人值守）之间切换 |
| `agent_stop` | 中止当前轮（进展已持久化至工作目录，不丢失）|
| `agent_runlog` | 引擎级运行日志，用于区分「确属路线不通」与「模型漂移 / idle 超时」|

**模式二 · 经验库直驱**（强模型带自建经验库，亲自调用）

| 工具 | 说明 |
|---|---|
| `agent_call_tool` | **直驱核心动作** —— 强模型亲自直调一个浏览器引擎工具（跳过 worker）。先 `agent_tools` 查 `name`/参数，再 `agent_call_tool({name, args})`。返回工具信封（`ok`/`data`/`error`，永不抛、已校验未知工具与缺参）。⚠ 有 worker 会话运行时被拒绝（共享页面 / hook 状态）；需 firefox-reverse **v0.20.0+** |

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
