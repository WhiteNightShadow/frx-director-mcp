import { mkdirSync, openSync, writeSync, closeSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A lease this stale (not renewed within) is treated as abandoned and reclaimed —
 *  the backstop for an owner SIGKILL'd (no graceful release) whose PID was reused
 *  by a live process, so PID-liveness alone can't tell it died. */
const STALE_TTL_MS = 5 * 60_000;
/** Throttle: renew() rewrites the lease at most this often. Far below STALE_TTL_MS
 *  so an active owner's lease never looks stale; the director polls every ≤30s. */
const RENEW_MIN_MS = 60_000;

export interface LockInfo {
  pid: number;
  ppid: number;
  host: string;
  port: number;
  ts: number;
}

/** Is `pid` a live process? ESRCH = dead; EPERM = alive but not ours. */
function isAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Cross-process advisory lock for Firefox's single-client Marionette session.
 *
 * Every MCP client session spawns its own frx-director process; without
 * coordination they all eagerly open Marionette (port 2828) and steal the single
 * session slot from one another — the "frx_status ready=true, then agent_start
 * 'marionette not connected'" flapping. This lock serialises ownership: exactly
 * one process holds it (and the connection) at a time; the rest wait briefly then
 * run degraded with a clear "another session owns the browser (PID X)" error, and
 * take over cleanly the moment the owner exits.
 *
 * It's a renewable lease, not a permanent grab. Reclaimed when the holder is (a)
 * a dead PID, (b) the same pid+ppid as us (our own crashed incarnation), or (c)
 * stale — not renewed within STALE_TTL_MS, which covers a SIGKILL'd owner even if
 * its PID was reused. An active owner renews on every browser op, so it is never
 * mistaken for stale. Zero-dependency.
 */
export class MarionetteLock {
  private held = false;
  private cleanupRegistered = false;
  private lastWrite = 0;

  constructor(
    private path: string,
    private self: Omit<LockInfo, "ts">,
  ) {}

  isHeld(): boolean {
    return this.held;
  }

  /** Read the current holder's info (best-effort; for error messages). */
  currentHolder(): LockInfo | null {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as LockInfo;
    } catch {
      return null;
    }
  }

  /** True iff the lock file represents an owner that's still genuinely ours. */
  private isOurs(holder: LockInfo | null): boolean {
    return !!holder && holder.pid === this.self.pid && holder.ppid === this.self.ppid;
  }

  /** True iff the lock file may be reclaimed (dead/abandoned holder, or our own残留). */
  private isReclaimable(holder: LockInfo | null): boolean {
    if (!holder) return true;
    if (this.isOurs(holder)) return true; // leftover from a prior incarnation of THIS process
    return !isAlive(holder.pid) || Date.now() - holder.ts > STALE_TTL_MS;
  }

  /** Try once to grab the lock. Reclaims a stale/dead lock atomically-ish. */
  private tryAcquire(): boolean {
    if (this.held) return true;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* ignore */
    }
    try {
      const fd = openSync(this.path, "wx"); // O_CREAT|O_EXCL|O_WRONLY — atomic
      try {
        writeSync(fd, JSON.stringify({ ...this.self, ts: Date.now() } satisfies LockInfo));
      } finally {
        closeSync(fd);
      }
      this.held = true;
      this.lastWrite = Date.now();
      this.registerCleanup();
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = this.currentHolder();
      if (this.isOurs(holder)) {
        // Left over from a prior incarnation of THIS pid+ppid — reclaim as ours.
        this.held = true;
        this.lastWrite = holder!.ts;
        this.registerCleanup();
        return true;
      }
      if (this.isReclaimable(holder)) {
        // Dead/abandoned holder. Remove it; the next loop iteration re-creates it.
        try {
          unlinkSync(this.path);
        } catch {
          /* lost the reclaim race to another process — fine, just retry */
        }
      }
      return false;
    }
  }

  /** Wait up to timeoutMs to acquire. Returns true iff we own the lock. */
  async acquire(timeoutMs: number): Promise<boolean> {
    if (this.held) return true;
    const deadline = Date.now() + timeoutMs;
    let backoff = 100;
    for (;;) {
      if (this.tryAcquire()) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await sleep(Math.min(backoff, left));
      backoff = Math.min(backoff * 2, 800);
    }
  }

  /** Renew our lease so an active owner is never mistaken for stale. Throttled, and
   *  concedes (held=false) if the lock was reclaimed out from under us. Call after a
   *  successful browser op. */
  renew(): void {
    if (!this.held) return;
    if (Date.now() - this.lastWrite < RENEW_MIN_MS) return;
    const holder = this.currentHolder();
    if (!this.isOurs(holder)) {
      // Someone reclaimed us (we went stale, or the file was replaced). Concede.
      this.held = false;
      return;
    }
    try {
      writeFileSync(this.path, JSON.stringify({ ...this.self, ts: Date.now() } satisfies LockInfo));
      this.lastWrite = Date.now();
    } catch {
      /* ignore */
    }
  }

  /** Release the lock if we hold it (only removes the file if it's still ours). */
  release(): void {
    if (!this.held) return;
    this.held = false;
    const holder = this.currentHolder();
    if (!holder || this.isOurs(holder)) {
      try {
        unlinkSync(this.path);
      } catch {
        /* ignore */
      }
    }
  }

  /** Best-effort unlink on graceful exit. SIGKILL skips this — the STALE_TTL_MS
   *  lease + PID-liveness check reclaim such locks instead. */
  private registerCleanup(): void {
    if (this.cleanupRegistered) return;
    this.cleanupRegistered = true;
    process.once("exit", () => this.release());
  }
}
