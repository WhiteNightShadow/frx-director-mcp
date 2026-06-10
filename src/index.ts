#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { MarionetteBridge } from "./bridge/MarionetteBridge.js";
import { FileBridge } from "./bridge/FileBridge.js";
import type { BrowserBridge } from "./bridge/BrowserBridge.js";
import { ensureBrowser } from "./launcher.js";
import { Director } from "./director.js";
import { registerTools } from "./server.js";

function makeBridge(): BrowserBridge {
  if (config.bridge === "file") return new FileBridge(config.fileBridgeDir);
  return new MarionetteBridge(config.marionetteHost, config.marionettePort);
}

async function main(): Promise<void> {
  // stdio transport: all human-readable diagnostics MUST go to stderr (stdout is
  // the MCP JSON-RPC channel).
  const logErr = (...a: unknown[]) => console.error("[frx-director-mcp]", ...a);

  if (config.bridge === "marionette") {
    const res = await ensureBrowser({
      host: config.marionetteHost,
      port: config.marionettePort,
      autolaunch: config.autolaunch,
      firefoxBin: config.firefoxBin,
      profile: config.profile,
      portWaitSec: config.portWaitSec,
    });
    if (!res.reachable) {
      logErr(
        `Marionette ${config.marionetteHost}:${config.marionettePort} 不可达。` +
          "请用 `-marionette -remote-allow-system-access -profile <PROFILE>` 启动 Firefox Reverse," +
          "或设 FRX_AUTOLAUNCH=1 + FRX_FIREFOX_BIN。",
      );
    } else {
      logErr(`Marionette reachable on ${config.marionetteHost}:${config.marionettePort}` + (res.launched ? " (launched)" : ""));
    }
  }

  const bridge = makeBridge();
  try {
    await bridge.connect();
    logErr("bridge connected:", config.bridge);
  } catch (e) {
    logErr("bridge connect failed:", (e as Error).message);
    // Still start the MCP server so tool calls return a clear error rather than the
    // whole server failing to launch under the client.
  }

  const director = new Director(bridge, config);
  const server = new McpServer({ name: "frx-director-mcp", version: "0.1.0" });
  registerTools(server, director);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logErr("工作目录根:", config.workspaceRoot, "| 会话数据:", config.dataDir);
  logErr("ready — 9 tools registered, listening on stdio");

  const shutdown = async () => {
    try {
      await bridge.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[frx-director-mcp] fatal:", e);
  process.exit(1);
});
