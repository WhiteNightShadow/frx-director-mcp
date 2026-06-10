import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Msg {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface Session {
  tid: string;
  workspaceRoot: string;
  mode: "assist" | "auto";
  model: string | null;
  convo: Msg[];
  createdAt: number;
}

/**
 * Owns per-tid session state: the workspace binding, the assist/auto mode, and
 * the authoritative convo array (the user turns the director authored + the
 * assistant conclusions carried forward). Persisted to <dataDir>/<tid>/convo.json,
 * mirroring frx_drive.py's convo-*.json so a crashed director can resume.
 */
export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(private dataDir: string) {
    mkdirSync(this.dataDir, { recursive: true });
    this.loadAll();
  }

  private dir(tid: string): string {
    return join(this.dataDir, tid.replace(/[^A-Za-z0-9._-]/g, "_"));
  }

  private loadAll(): void {
    if (!existsSync(this.dataDir)) return;
    for (const name of readdirSync(this.dataDir)) {
      const f = join(this.dataDir, name, "session.json");
      if (!existsSync(f)) continue;
      try {
        const s = JSON.parse(readFileSync(f, "utf8")) as Session;
        this.sessions.set(s.tid, s);
      } catch {
        /* skip corrupt */
      }
    }
  }

  private persist(s: Session): void {
    const d = this.dir(s.tid);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "session.json"), JSON.stringify(s, null, 1), "utf8");
    writeFileSync(join(d, "convo.json"), JSON.stringify(s.convo, null, 1), "utf8");
  }

  create(tid: string, workspaceRoot: string, mode: "assist" | "auto", model: string | null): Session {
    const s: Session = { tid, workspaceRoot, mode, model, convo: [], createdAt: Date.now() };
    this.sessions.set(tid, s);
    this.persist(s);
    return s;
  }

  get(tid: string): Session | undefined {
    return this.sessions.get(tid);
  }

  require(tid: string): Session {
    const s = this.sessions.get(tid);
    if (!s) throw new Error(`unknown tid "${tid}" — call agent_start first`);
    return s;
  }

  setConvo(tid: string, convo: Msg[]): void {
    const s = this.require(tid);
    s.convo = convo;
    this.persist(s);
  }

  setMode(tid: string, mode: "assist" | "auto"): void {
    const s = this.require(tid);
    s.mode = mode;
    this.persist(s);
  }
}
