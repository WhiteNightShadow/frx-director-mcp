import net from "node:net";
import { describe, it, expect } from "vitest";
import { MarionetteWire } from "../src/bridge/marionetteWire.js";

function frame(obj: unknown): Buffer {
  const b = Buffer.from(JSON.stringify(obj), "utf8");
  return Buffer.concat([Buffer.from(String(b.length) + ":", "ascii"), b]);
}

/** Minimal mock Marionette server speaking the `<len>:<json>` protocol. */
function startMock(): Promise<{ port: number; server: net.Server }> {
  const server = net.createServer((sock) => {
    sock.write(frame({ applicationType: "gecko", marionetteProtocol: 3 })); // hello
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const colon = buf.indexOf(0x3a);
        if (colon < 0) break;
        const len = parseInt(buf.subarray(0, colon).toString("ascii"), 10);
        if (buf.length < colon + 1 + len) break;
        const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString("utf8"));
        buf = buf.subarray(colon + 1 + len);
        const [, mid, name, params] = msg as [number, number, string, { args?: unknown[] }];
        let result: unknown;
        if (name === "WebDriver:ExecuteScript") result = { value: { echo: params.args } };
        else result = { value: null };
        sock.write(frame([1, mid, null, result]));
      }
    });
  });
  return new Promise((res) =>
    server.listen(0, "127.0.0.1", () => res({ port: (server.address() as net.AddressInfo).port, server })),
  );
}

describe("MarionetteWire framing", () => {
  it("connects, sets chrome context, executes, and unwraps .value", async () => {
    const { port, server } = await startMock();
    const w = new MarionetteWire();
    await w.connect("127.0.0.1", port, 5000);
    const r = await w.execute("return 1;", ["a", "b"]);
    expect(r).toEqual({ echo: ["a", "b"] });
    await w.close();
    server.close();
  });

  it("handles frames split across TCP chunks", async () => {
    // A server that dribbles its hello + response one byte at a time.
    const server = net.createServer((sock) => {
      const send = (buf: Buffer) => {
        for (const byte of buf) sock.write(Buffer.from([byte]));
      };
      send(frame({ applicationType: "gecko" }));
      let buf = Buffer.alloc(0);
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        for (;;) {
          const colon = buf.indexOf(0x3a);
          if (colon < 0) break;
          const len = parseInt(buf.subarray(0, colon).toString("ascii"), 10);
          if (buf.length < colon + 1 + len) break;
          const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString("utf8"));
          buf = buf.subarray(colon + 1 + len);
          send(frame([1, (msg as [number, number])[1], null, { value: "ok" }]));
        }
      });
    });
    const port: number = await new Promise((res) =>
      server.listen(0, "127.0.0.1", () => res((server.address() as net.AddressInfo).port)),
    );
    const w = new MarionetteWire();
    await w.connect("127.0.0.1", port, 5000);
    expect(await w.execute("return 'ok';")).toBe("ok");
    await w.close();
    server.close();
  });
});
