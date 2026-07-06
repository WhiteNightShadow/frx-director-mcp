import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import net from "node:net";

type JsonRecord = Record<string, unknown>;
const DEFAULT_PORT_BASE = 2828;
const AUTOMATION_STEALTH_PREFS: Record<string, string | number | boolean> = {
  "remote.prefs.recommended": false,
  "frx.hideRemoteControlCue": true,
  "browser.chrome.disableRemoteControlCueForTests": true,
  "browser.privatebrowsing.autostart": false,
  "browser.startup.couldRestoreSession.count": -1,
  "browser.sessionstore.resume_from_crash": false,
  "places.history.enabled": true,
  "dom.storage.enabled": true,
  "browser.cache.disk.enable": true,
  "browser.cache.memory.enable": true,
  "privacy.sanitize.sanitizeOnShutdown": false,
  "privacy.clearOnShutdown.history": false,
  "privacy.clearOnShutdown.formdata": false,
  "privacy.clearOnShutdown.downloads": false,
  "privacy.clearOnShutdown.cookies": false,
  "privacy.clearOnShutdown.cache": false,
  "privacy.clearOnShutdown.sessions": false,
  "privacy.clearOnShutdown_v2.historyFormDataAndDownloads": false,
  "privacy.clearOnShutdown_v2.browsingHistoryAndDownloads": false,
  "privacy.clearOnShutdown_v2.cookiesAndStorage": false,
  "privacy.clearOnShutdown_v2.cache": false,
  "dom.permissions.testing.enabled": false,
  "media.navigator.permission.disabled": false,
  "media.navigator.streams.fake": false,
};
const MINIMAL_AUTOMATION_FINGERPRINT = JSON.stringify({
  schemaVersion: 1,
  enabled: true,
  source: { type: "mcp-automation-baseline" },
  navigator: { webdriver: { enabled: true, value: false } },
});

export interface BrowserLaunch {
  port: number;
  profile: string;
  extraEnv: Record<string, string>;
  envId: string;
  envName: string;
  processLabel: string;
  envPath: string;
  runtimePath: string;
}

/** Probe a TCP port (resolves true if connectable). */
function probe(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

export async function waitPort(host: string, port: number, timeoutSec: number): Promise<boolean> {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    if (await probe(host, port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function readJSON(path: string): JsonRecord {
  return JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
}

function writeJSON(path: string, data: JsonRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

function readOptionalJSONText(path: string): string {
  if (!path || !existsSync(path)) return "";
  try {
    const text = readFileSync(path, "utf8");
    return JSON.stringify(JSON.parse(text));
  } catch {
    return "";
  }
}

function isObj(v: unknown): v is JsonRecord {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function validateEnvId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) {
    throw new Error("FRX_ENV_ID contains invalid characters");
  }
}

function envString(env: JsonRecord, key: string, fallback: string): string {
  const v = env[key];
  return typeof v === "string" && v ? v : fallback;
}

function envRuntime(env: JsonRecord): JsonRecord {
  const rt = env.runtime;
  return isObj(rt) ? rt : {};
}

function processSlotLabel(port: number): string {
  if (Number.isFinite(port) && port >= DEFAULT_PORT_BASE && port < DEFAULT_PORT_BASE + 200) {
    return `Firefox Reverse ${port - DEFAULT_PORT_BASE + 1}`;
  }
  return "Firefox Reverse";
}

function prefValue(v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
  return JSON.stringify(v);
}

function upsertUserPrefs(profile: string, prefs: Record<string, string | number | boolean>): void {
  if (!profile) return;
  const userJsPath = join(profile, "user.js");
  mkdirSync(profile, { recursive: true });
  const names = Object.keys(prefs);
  const oldText = existsSync(userJsPath) ? readFileSync(userJsPath, "utf8") : "";
  const kept = oldText
    .split(/\r?\n/)
    .filter(line => !names.some(name => line.includes(`user_pref("${name}"`)))
    .filter((line, i, arr) => line || i < arr.length - 1);
  const next = [
    ...kept,
    ...names.map(name => {
      const value = prefs[name];
      if (value === undefined) {
        return "";
      }
      return `user_pref(${JSON.stringify(name)}, ${prefValue(value)});`;
    }).filter(Boolean),
    "",
  ].join("\n");
  writeFileSync(userJsPath, next);
}

function hasFingerprintConfig(extraEnv: Record<string, string> = {}): boolean {
  return Boolean(
    extraEnv.MOZ_FRX_FINGERPRINT_CONFIG ||
      extraEnv.MOZ_FRX_FINGERPRINT_JSON ||
      process.env.MOZ_FRX_FINGERPRINT_CONFIG ||
      process.env.MOZ_FRX_FINGERPRINT_JSON,
  );
}

function automationFingerprintEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
  if (hasFingerprintConfig(extraEnv)) return {};
  return { MOZ_FRX_FINGERPRINT_JSON: MINIMAL_AUTOMATION_FINGERPRINT };
}

function usedManifestPorts(root: string, exceptId: string): Set<number> {
  const out = new Set<number>();
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) return out;
  try {
    const m = readJSON(manifestPath);
    const envs = Array.isArray(m.environments) ? m.environments : [];
    for (const item of envs) {
      if (!isObj(item) || item.id === exceptId) continue;
      const rt = envRuntime(item);
      const status = typeof rt.status === "string" ? rt.status : "";
      const port = Number(rt.marionettePort);
      if ((status === "running" || status === "starting") && Number.isFinite(port)) {
        out.add(port);
      }
    }
  } catch {
    /* ignore malformed manifest; env.json remains authoritative */
  }
  return out;
}

async function allocatePort(host: string, start: number, used: Set<number>, preferred?: number): Promise<number> {
  if (preferred && !used.has(preferred) && !(await probe(host, preferred, 300))) {
    return preferred;
  }
  for (let i = 0; i < 200; i++) {
    const port = start + i;
    if (!used.has(port) && !(await probe(host, port, 300))) return port;
  }
  throw new Error("no free Marionette port found for FRX_ENV_ID");
}

export async function resolveBrowserLaunch(opts: {
  host: string;
  port: number;
  profile: string;
  envId: string;
  envsRoot: string;
}): Promise<BrowserLaunch> {
  if (!opts.envId) {
    return {
      port: opts.port,
      profile: opts.profile,
      extraEnv: {},
      envId: "",
      envName: "",
      processLabel: "",
      envPath: "",
      runtimePath: "",
    };
  }
  validateEnvId(opts.envId);
  const envDir = join(opts.envsRoot, opts.envId);
  const envPath = join(envDir, "env.json");
  if (!existsSync(envPath)) {
    throw new Error(`FRX_ENV_ID not found: ${opts.envId} (${envPath})`);
  }
  const env = readJSON(envPath);
  const profile = envString(env, "profilePath", join(envDir, "profile"));
  const traceDir = envString(env, "traceDir", join(envDir, "traces"));
  const controlDir = envString(env, "controlDir", join(envDir, "control"));
  const fingerprintPath = envString(env, "fingerprintPath", join(envDir, "fingerprint.json"));
  const proxyPath = envString(env, "proxyPath", join(envDir, "proxy.json"));
  const fingerprintJson = readOptionalJSONText(fingerprintPath);
  const envName = envString(env, "name", opts.envId);
  const rt = envRuntime(env);
  const preferred = Number(rt.marionettePort);
  const used = usedManifestPorts(opts.envsRoot, opts.envId);
  const status = typeof rt.status === "string" ? rt.status : "stopped";
  const port =
    Number.isFinite(preferred) && status === "running" && (await probe(opts.host, preferred, 300))
      ? preferred
      : await allocatePort(opts.host, opts.port, used, Number.isFinite(preferred) ? preferred : undefined);
  const processLabel = processSlotLabel(port);
  const runtime = {
    ...rt,
    status: status === "running" && port === preferred ? "running" : "stopped",
    marionettePort: port,
    envName,
    processLabel,
  };
  env.runtime = runtime;
  writeJSON(envPath, env);
  const runtimePath = join(controlDir, "runtime.json");
  writeJSON(runtimePath, runtime);
  upsertUserPrefs(profile, {
    ...AUTOMATION_STEALTH_PREFS,
    "marionette.port": port,
    "frx.hideRemoteControlCue": true,
    "frx.environment.id": opts.envId,
    "frx.environment.name": envName,
    "frx.process.label": processLabel,
    "frx.fingerprint.config.path": fingerprintPath,
    ...(fingerprintJson ? { "frx.fingerprint.config.json": fingerprintJson } : {}),
    "frx.proxy.config.path": proxyPath,
  });
  return {
    port,
    profile,
    envId: opts.envId,
    envName,
    processLabel,
    envPath,
    runtimePath,
    extraEnv: {
      MOZ_FRX_ENV_ID: opts.envId,
      MOZ_FRX_ENV_NAME: envName,
      MOZ_FRX_PROCESS_LABEL: processLabel,
      MOZ_FRX_ENVS_ROOT: opts.envsRoot,
      MOZ_FRX_FINGERPRINT_CONFIG: fingerprintPath,
      ...(fingerprintJson ? { MOZ_FRX_FINGERPRINT_JSON: fingerprintJson } : {}),
      MOZ_FRX_PROXY_CONFIG: proxyPath,
      MOZ_FRX_TRACE_DIR: traceDir,
      MOZ_FRX_CONTROL_DIR: controlDir,
      MOZ_WEBAPI_TRACE_FILE: join(traceDir, "webapi.ndjson"),
      MOZ_WEBAPI_TRACE_CTL: join(controlDir, "webapi.ctl"),
      MOZ_JSVMP_TRACE_FILE: join(traceDir, "jsvmp.ndjson"),
      MOZ_FRX_HIDE_REMOTE_CONTROL_CUE: "1",
      FRX_ENV_ID: opts.envId,
      FRX_ENV_NAME: envName,
      FRX_ENVS_ROOT: opts.envsRoot,
    },
  };
}

function updateEnvRuntime(launch: BrowserLaunch, patch: JsonRecord): void {
  if (!launch.envId || !launch.envPath) return;
  try {
    const env = readJSON(launch.envPath);
    const runtime = { ...envRuntime(env), ...patch };
    env.runtime = runtime;
    writeJSON(launch.envPath, env);
    if (launch.runtimePath) writeJSON(launch.runtimePath, runtime);
  } catch {
    /* status writeback is best-effort */
  }
}

/**
 * Optionally spawn "Firefox Reverse" with marionette + system access. The
 * REQUIRED flags are `-marionette -remote-allow-system-access` (chrome SetContext
 * needs system access).
 */
export async function ensureBrowser(opts: {
  host: string;
  port: number;
  autolaunch: boolean;
  firefoxBin: string;
  profile: string;
  portWaitSec: number;
  extraEnv?: Record<string, string>;
  launch?: BrowserLaunch;
}): Promise<{ launched: boolean; reachable: boolean }> {
  if (await probe(opts.host, opts.port)) return { launched: false, reachable: true };

  if (!opts.autolaunch) {
    return { launched: false, reachable: false };
  }
  if (!opts.firefoxBin) throw new Error("FRX_AUTOLAUNCH=1 but FRX_FIREFOX_BIN is unset");

  const args = ["-marionette", "-remote-allow-system-access", "-no-remote", "--marionette-port", String(opts.port)];
  if (opts.profile) args.push("-profile", opts.profile);
  upsertUserPrefs(opts.profile, {
    ...AUTOMATION_STEALTH_PREFS,
    "marionette.port": opts.port,
    "frx.hideRemoteControlCue": true,
    ...(opts.launch?.envId ? {
      "frx.environment.id": opts.launch.envId,
      "frx.environment.name": opts.launch.envName,
      "frx.process.label": opts.launch.processLabel,
    } : {}),
  });
  const extraEnv = opts.extraEnv || {};
  const child = spawn(opts.firefoxBin, args, {
    detached: true,
    stdio: "ignore",
    argv0: opts.launch?.processLabel || undefined,
    env: {
      ...process.env,
      MOZ_FRX_HIDE_REMOTE_CONTROL_CUE: "1",
      ...automationFingerprintEnv(extraEnv),
      ...extraEnv,
    },
  });
  updateEnvRuntime(opts.launch || {
    port: opts.port,
    profile: opts.profile,
    extraEnv: opts.extraEnv || {},
    envId: "",
    envName: "",
    processLabel: "",
    envPath: "",
    runtimePath: "",
  }, {
    status: "running",
    pid: child.pid ?? null,
    marionettePort: opts.port,
    lastStartedAt: new Date().toISOString(),
    ...(opts.launch?.envName ? { envName: opts.launch.envName } : {}),
    ...(opts.launch?.processLabel ? { processLabel: opts.launch.processLabel } : {}),
  });
  child.unref();

  const reachable = await waitPort(opts.host, opts.port, opts.portWaitSec);
  if (!reachable) {
    updateEnvRuntime(opts.launch || {
      port: opts.port,
      profile: opts.profile,
      extraEnv: opts.extraEnv || {},
      envId: "",
      envName: "",
      processLabel: "",
      envPath: "",
      runtimePath: "",
    }, {
      status: "stopped",
      pid: null,
      lastStoppedAt: new Date().toISOString(),
      stopReason: "port-not-reachable",
    });
  }
  return { launched: true, reachable };
}
