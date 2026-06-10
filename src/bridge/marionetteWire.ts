import net from "node:net";

/** Marionette protocol error (the `err` object of a `[1, mid, err, res]` frame). */
export class MarionetteError extends Error {
  constructor(public detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.name = "MarionetteError";
  }
}

/**
 * Length-prefixed Marionette transport: each frame on the wire is `<len>:<utf8-json>`.
 * Commands are `[0, msgId, name, params]`; responses `[1, msgId, err, result]`.
 * A faithful async TS port of frx_drive.py's Marionette class.
 */
export class MarionetteWire {
  private sock: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  /** FIFO of pending readFrame() resolvers. */
  private waiters: Array<{ resolve: (f: unknown) => void; reject: (e: Error) => void }> = [];
  private mid = 0;
  private closed = false;

  async connect(host: string, port: number, timeoutMs = 180_000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ host, port });
      s.setTimeout(timeoutMs);
      const onErr = (e: Error) => reject(e);
      s.once("error", onErr);
      s.once("connect", () => {
        s.removeListener("error", onErr);
        s.on("data", (d) => this.onData(d));
        s.on("error", (e) => this.fail(e));
        s.on("close", () => this.fail(new Error("marionette closed")));
        s.on("timeout", () => this.fail(new Error("marionette socket timeout")));
        this.sock = s;
        resolve();
      });
    });
    await this.readFrame(); // gecko hello
    await this.command("WebDriver:NewSession", {});
    await this.command("Marionette:SetContext", { value: "chrome" });
  }

  private fail(e: Error): void {
    if (this.closed) return;
    this.closed = true;
    const w = this.waiters.splice(0);
    for (const { reject } of w) reject(e);
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    this.drain();
  }

  /** Resolve as many waiters as there are complete frames buffered. */
  private drain(): void {
    while (this.waiters.length) {
      const frame = this.takeFrame();
      if (frame === undefined) return;
      this.waiters.shift()!.resolve(frame);
    }
  }

  /** Parse one `<len>:<json>` frame off the buffer, or undefined if incomplete. */
  private takeFrame(): unknown | undefined {
    const colon = this.buf.indexOf(0x3a); // ':'
    if (colon < 0) return undefined;
    const len = parseInt(this.buf.subarray(0, colon).toString("ascii"), 10);
    if (Number.isNaN(len)) {
      this.fail(new Error("bad marionette frame length"));
      return undefined;
    }
    const start = colon + 1;
    if (this.buf.length < start + len) return undefined;
    const json = this.buf.subarray(start, start + len).toString("utf8");
    this.buf = this.buf.subarray(start + len);
    try {
      return JSON.parse(json);
    } catch (e) {
      this.fail(new Error("bad marionette frame json: " + (e as Error).message));
      return undefined;
    }
  }

  private readFrame(): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("marionette closed"));
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.drain();
    });
  }

  async command(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.sock || this.closed) throw new Error("marionette not connected");
    const id = ++this.mid;
    const payload = Buffer.from(JSON.stringify([0, id, name, params]), "utf8");
    this.sock.write(Buffer.concat([Buffer.from(String(payload.length) + ":", "ascii"), payload]));
    for (;;) {
      const fr = await this.readFrame();
      if (Array.isArray(fr) && fr.length >= 4 && fr[0] === 1 && fr[1] === id) {
        const [, , err, res] = fr;
        if (err) throw new MarionetteError(err);
        return res;
      }
      // ignore async events / mismatched ids
    }
  }

  /** Run privileged chrome JS; returns its `return`ed value. */
  async execute(script: string, args: unknown[] = [], timeoutMs = 120_000): Promise<unknown> {
    const res = await this.command("WebDriver:ExecuteScript", {
      script,
      args,
      newSandbox: false,
      scriptTimeout: timeoutMs,
    });
    return res && typeof res === "object" && "value" in res ? (res as { value: unknown }).value : res;
  }

  /** Run async chrome JS — the script receives a resolve callback as its LAST arg. */
  async executeAsync(script: string, args: unknown[] = [], timeoutMs = 120_000): Promise<unknown> {
    const res = await this.command("WebDriver:ExecuteAsyncScript", {
      script,
      args,
      newSandbox: false,
      scriptTimeout: timeoutMs,
    });
    return res && typeof res === "object" && "value" in res ? (res as { value: unknown }).value : res;
  }

  async close(): Promise<void> {
    try {
      await this.command("Marionette:AcceptConnections", { value: true });
    } catch {
      /* ignore */
    }
    this.closed = true;
    try {
      this.sock?.destroy();
    } catch {
      /* ignore */
    }
  }
}
