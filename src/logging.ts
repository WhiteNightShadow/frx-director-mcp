import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StateSnap } from "./bridge/BrowserBridge.js";

/** Redact anything resembling an API key, defensively (the server never holds one). */
export function redact(s: string): string {
  return s.replace(/sk-[A-Za-z0-9_\-]{12,}/g, "sk-***REDACTED***");
}

/**
 * Per-tid turnlog (NDJSON, mirrors reverse-lab/_harness/turnlog-*.ndjson) plus a
 * guidance archive of every director correction — for replay/debug. Keys redacted.
 */
export class TurnLogger {
  constructor(private dataDir: string) {
    mkdirSync(this.dataDir, { recursive: true });
  }

  private dir(tid: string): string {
    const d = join(this.dataDir, tid.replace(/[^A-Za-z0-9._-]/g, "_"));
    mkdirSync(d, { recursive: true });
    return d;
  }

  turn(tid: string, elapsedSec: number, st: StateSnap | null): void {
    const rec = { at: Math.floor(Date.now() / 1000), el: elapsedSec, st };
    try {
      appendFileSync(join(this.dir(tid), "turnlog.ndjson"), redact(JSON.stringify(rec)) + "\n", "utf8");
    } catch {
      /* logging must never break the loop */
    }
  }

  guidance(tid: string, seq: number, text: string): void {
    try {
      writeFileSync(join(this.dir(tid), `guidance-${seq}.txt`), redact(text), "utf8");
    } catch {
      /* ignore */
    }
  }

  event(tid: string, kind: string, data: unknown): void {
    const rec = { at: Math.floor(Date.now() / 1000), kind, data };
    try {
      appendFileSync(join(this.dir(tid), "events.ndjson"), redact(JSON.stringify(rec)) + "\n", "utf8");
    } catch {
      /* ignore */
    }
  }
}
