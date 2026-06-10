import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/** Minimal zero-dependency .env loader (KEY=VALUE, # comments). Real env wins. */
function loadDotEnv(): void {
  const p = resolve(process.cwd(), ".env");
  if (!existsSync(p)) return;
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
}
loadDotEnv();

const env = process.env;
const num = (v: string | undefined, d: number) => (v && !Number.isNaN(+v) ? +v : d);

export const config = {
  marionetteHost: env.FRX_MARIONETTE_HOST || "127.0.0.1",
  marionettePort: num(env.FRX_MARIONETTE_PORT, 2828),
  portWaitSec: num(env.FRX_PORT_WAIT_SEC, 90),

  autolaunch: env.FRX_AUTOLAUNCH === "1",
  firefoxBin: env.FRX_FIREFOX_BIN || "",
  profile: env.FRX_PROFILE || "",

  jsxPromptSrc: env.FRX_JSX_PROMPT_SRC || "",
  defaultModel: env.FRX_DEFAULT_MODEL || "",

  workspaceRoot: env.FRX_WORKSPACE_ROOT || resolve(process.cwd(), "workspaces"),
  dataDir: env.FRX_DATA_DIR || resolve(process.cwd(), "data"),

  /** Bridge transport. "marionette" is the proven default; "file" is a stub seam. */
  bridge: (env.FRX_BRIDGE || "marionette") as "marionette" | "file",
  fileBridgeDir: env.FRX_FILE_BRIDGE_DIR || "/tmp/frx-bridge",
} as const;

export type Config = typeof config;
