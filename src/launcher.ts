import { spawn, execFileSync } from "node:child_process";
import net from "node:net";

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

/**
 * Optionally spawn "Firefox Reverse" with marionette + system access. The
 * REQUIRED flags are `-marionette -remote-allow-system-access` (chrome SetContext
 * needs system access). Kills a stale instance by matching the app path — using
 * pgrep|kill, NEVER `pkill -f <name>` (that can self-kill this Node process).
 */
export async function ensureBrowser(opts: {
  host: string;
  port: number;
  autolaunch: boolean;
  firefoxBin: string;
  profile: string;
  portWaitSec: number;
}): Promise<{ launched: boolean; reachable: boolean }> {
  if (await probe(opts.host, opts.port)) return { launched: false, reachable: true };

  if (!opts.autolaunch) {
    return { launched: false, reachable: false };
  }
  if (!opts.firefoxBin) throw new Error("FRX_AUTOLAUNCH=1 but FRX_FIREFOX_BIN is unset");

  // Best-effort kill of a stale instance bound to this binary (pgrep + kill).
  try {
    const out = execFileSync("pgrep", ["-f", opts.firefoxBin], { encoding: "utf8" }).trim();
    const pids = out.split("\n").filter(Boolean);
    if (pids.length) execFileSync("kill", pids, { stdio: "ignore" });
  } catch {
    /* none running / pgrep absent — fine */
  }

  const args = ["-marionette", "-remote-allow-system-access", "-no-remote"];
  if (opts.profile) args.push("-profile", opts.profile);
  const child = spawn(opts.firefoxBin, args, { detached: true, stdio: "ignore" });
  child.unref();

  const reachable = await waitPort(opts.host, opts.port, opts.portWaitSec);
  return { launched: true, reachable };
}
