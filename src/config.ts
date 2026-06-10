import { readFileSync, existsSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// 包根目录（dist/config.js 的上两级）。用它定位 .env，而不是依赖启动进程的 cwd ——
// MCP 客户端（Claude Desktop / Cursor / Claude Code）启动 node 时的 cwd 通常不是本仓库目录。
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 极简零依赖 .env 加载：先包根、再 cwd，找到第一个即生效。真实环境变量优先于 .env。 */
function loadDotEnv(): void {
  for (const dir of [PKG_ROOT, process.cwd()]) {
    const p = resolve(dir, ".env");
    if (!existsSync(p)) continue;
    for (const raw of readFileSync(p, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[k] === undefined) process.env[k] = v;
    }
    break;
  }
}
loadDotEnv();

const env = process.env;
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(+v) ? +v : d);

// 工作目录（逆向产物：脚本、还原代码、ledger.md / progress.md）应归属 firefox-reverse 项目，
// 而非 MCP 工具自身的目录。优先从 FRX_JSX_PROMPT_SRC 推断 firefox-reverse 仓库位置，把工作目录
// 放在该仓库旁（`<仓库父目录>/firefox-reverse-ws`）；推断不出再退回主目录 `~/firefox-reverse-ws`。
// 始终可写、好找、与启动 cwd 无关，且与 MCP 工具自身解耦。
function defaultWorkspaceRoot(): string {
  const jsx = env.FRX_JSX_PROMPT_SRC || "";
  const i = jsx.indexOf("/additions/");
  if (i > 0) {
    const repoRoot = jsx.slice(0, i); // …/firefox-reverse
    return join(dirname(repoRoot), "firefox-reverse-ws");
  }
  return join(homedir(), "firefox-reverse-ws");
}

// MCP 自身的内部状态（每会话 convo / turnlog，非逆向产物）—— 放在 MCP 工具的隐藏目录是合适的。
const FRX_DATA_HOME = join(homedir(), ".frx-director-mcp");

export const config = {
  marionetteHost: env.FRX_MARIONETTE_HOST || "127.0.0.1",
  marionettePort: num(env.FRX_MARIONETTE_PORT, 2828),
  portWaitSec: num(env.FRX_PORT_WAIT_SEC, 90),

  autolaunch: env.FRX_AUTOLAUNCH === "1",
  firefoxBin: env.FRX_FIREFOX_BIN || "",
  profile: env.FRX_PROFILE || "",

  jsxPromptSrc: env.FRX_JSX_PROMPT_SRC || "",
  defaultModel: env.FRX_DEFAULT_MODEL || "",

  workspaceRoot: env.FRX_WORKSPACE_ROOT || defaultWorkspaceRoot(),
  dataDir: env.FRX_DATA_DIR || join(FRX_DATA_HOME, "data"),

  /** Bridge transport. "marionette" is the proven default; "file" is a stub seam. */
  bridge: (env.FRX_BRIDGE || "marionette") as "marionette" | "file",
  fileBridgeDir: env.FRX_FILE_BRIDGE_DIR || "/tmp/frx-bridge",
} as const;

export type Config = typeof config;
