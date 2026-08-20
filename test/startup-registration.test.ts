import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type RpcMessage = {
  id?: number;
  result?: {
    tools?: Array<{ name?: string }>;
    content?: Array<{ type?: string; text?: string }>;
  };
  error?: unknown;
};

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

describe("MCP startup registration", () => {
  it("registers tools before a broken Firefox autolaunch can terminate startup", async () => {
    const port = await findFreePort();
    const env = {
      ...process.env,
      FRX_AUTOLAUNCH: "1",
      FRX_FIREFOX_BIN: "",
      FRX_PROFILE: "",
      FRX_ENV_ID: "",
      FRX_BRIDGE: "marionette",
      FRX_MARIONETTE_HOST: "127.0.0.1",
      FRX_MARIONETTE_PORT: String(port),
      FRX_PORT_WAIT_SEC: "0",
    };
    const child = spawn(process.execPath, [join(process.cwd(), "dist", "index.js")], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const messages: RpcMessage[] = [];
    let stdoutBuffer = "";
    const waiters = new Map<number, (message: RpcMessage) => void>();
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += String(chunk);
      let newline: number;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as RpcMessage;
        messages.push(message);
        if (typeof message.id === "number") {
          waiters.get(message.id)?.(message);
          waiters.delete(message.id);
        }
      }
    });

    const waitFor = (id: number, timeoutMs = 2500): Promise<RpcMessage> => {
      const existing = messages.find((message) => message.id === id);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`timed out waiting for MCP response id=${id}; stderr=${stderr.slice(-1000)}`));
        }, timeoutMs);
        waiters.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    };

    try {
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "startup-registration-test", version: "1.0.0" },
          },
        }) + "\n",
      );
      const initialized = await waitFor(1);
      expect(initialized.error).toBeUndefined();

      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n",
      );
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
      const listed = await waitFor(2);
      const names = listed.result?.tools?.map((tool) => tool.name) || [];
      expect(names).toContain("frx_status");
      expect(names).toContain("agent_tools");
      expect(names).toContain("agent_call_tool");
      expect(names).not.toContain("open_url");
      expect(child.exitCode).toBeNull();

      for (let i = 0; i < 20 && !stderr.includes("FRX_FIREFOX_BIN is unset"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "frx_status", arguments: {} },
        }) + "\n",
      );
      const statusResponse = await waitFor(3);
      const statusText = statusResponse.result?.content?.find((item) => item.type === "text")?.text || "{}";
      const status = JSON.parse(statusText) as {
        mcpToolsRegistered?: boolean;
        startup?: { phase?: string; error?: string };
      };
      expect(status.mcpToolsRegistered).toBe(true);
      expect(status.startup?.phase).toBe("degraded");
      expect(status.startup?.error).toContain("FRX_FIREFOX_BIN is unset");

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(stderr).toContain("MCP tools registered on stdio");
      expect(stderr).toContain("FRX_FIREFOX_BIN is unset");
    } finally {
      child.stdin.end();
      await stopChild(child);
    }
  }, 10_000);
});
