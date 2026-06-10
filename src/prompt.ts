import { readFileSync, existsSync, statSync } from "node:fs";

/**
 * Build the worker's system prompt, kept in sync with the SHIPPED UI by
 * regex-extracting SYSTEM + ASSIST_BLOCK / AUTO_BLOCK live from AgentPanel.jsx
 * (same approach as frx_drive.py build_sys), then appending the workspace block.
 *
 * If the jsx path is unset/missing, a minimal built-in fallback is used so the
 * server still runs (assist:true alone makes the engine stage-gate).
 */

const FALLBACK_SYSTEM =
  "你是 firefox-reverse 浏览器内置的逆向 Agent。站点无关、通用。用你自己的工具走通常规逆向链路，" +
  "产出不依赖浏览器运行时的 Node 复刻。开工先 skill_get。";
const FALLBACK_ASSIST =
  "\n\n【AI 辅助模式】做完一个阶段就停下，简要汇报：①已确认的发现 ②2-3 个候选方向 ③你的推荐，然后等待指示。" +
  "用户的当前指令优先于这个模板：给了明确指令就照做做到底、如实回报真实结果。";
const FALLBACK_AUTO = "\n\n【全自动模式】连续推进直到完成目标或确实卡住，不要中途停下等待。";

let cache: { path: string; mtime: number; system: string; assist: string; auto: string } | null = null;

function extract(txt: string, name: string): string | null {
  const m = txt.match(new RegExp("const " + name + " = `([\\s\\S]*?)`;"));
  if (!m || m[1] === undefined) return null;
  return m[1].replace(/\\`/g, "`").replace(/\\\$/g, "$");
}

function loadFromJsx(jsxPath: string) {
  const { mtimeMs } = statSync(jsxPath);
  if (cache && cache.path === jsxPath && cache.mtime === mtimeMs) return cache;
  const txt = readFileSync(jsxPath, "utf8");
  const system = extract(txt, "SYSTEM");
  if (!system) throw new Error(`cannot extract SYSTEM from ${jsxPath}`);
  cache = {
    path: jsxPath,
    mtime: mtimeMs,
    system,
    assist: extract(txt, "ASSIST_BLOCK") ?? FALLBACK_ASSIST,
    auto: extract(txt, "AUTO_BLOCK") ?? FALLBACK_AUTO,
  };
  return cache;
}

function workspaceBlock(workspace: string): string {
  return (
    `\n\n【当前工作目录】${workspace}\n` +
    "用 fs_list/fs_read/fs_write 读写其中文件、run_node/run_python 在此目录执行脚本验证；" +
    "jsvmp/webapi trace 自动镜像到其子目录。把抓取的脚本、还原出的实现、笔记都存到这里（ledger.md / progress.md）。"
  );
}

export function buildSystemPrompt(
  jsxPath: string,
  workspace: string,
  mode: "assist" | "auto",
): string {
  let base = FALLBACK_SYSTEM;
  let assist = FALLBACK_ASSIST;
  let auto = FALLBACK_AUTO;
  if (jsxPath && existsSync(jsxPath)) {
    const c = loadFromJsx(jsxPath);
    base = c.system;
    assist = c.assist;
    auto = c.auto;
  }
  return base + workspaceBlock(workspace) + (mode === "auto" ? auto : assist);
}
