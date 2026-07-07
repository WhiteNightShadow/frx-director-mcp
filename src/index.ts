#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { MarionetteBridge } from "./bridge/MarionetteBridge.js";
import { FileBridge } from "./bridge/FileBridge.js";
import type { BrowserBridge } from "./bridge/BrowserBridge.js";
import { ensureBrowser, resolveBrowserLaunch } from "./launcher.js";
import { Director } from "./director.js";
import { registerTools } from "./server.js";

function makeBridge(port = config.marionettePort): BrowserBridge {
  if (config.bridge === "file") return new FileBridge(config.fileBridgeDir);
  return new MarionetteBridge(config.marionetteHost, port);
}

async function main(): Promise<void> {
  // stdio transport: all human-readable diagnostics MUST go to stderr (stdout is
  // the MCP JSON-RPC channel).
  const logErr = (...a: unknown[]) => console.error("[frx-director-mcp]", ...a);

  const launch =
    config.bridge === "marionette"
      ? await resolveBrowserLaunch({
          host: config.marionetteHost,
          port: config.marionettePort,
          profile: config.profile,
          envId: config.envId,
          envsRoot: config.envsRoot,
        })
      : {
          port: config.marionettePort,
          profile: config.profile,
          extraEnv: {},
          envId: "",
          envName: "",
          processLabel: "",
          envPath: "",
          runtimePath: "",
        };

  if (config.bridge === "marionette") {
    const res = await ensureBrowser({
      host: config.marionetteHost,
      port: launch.port,
      autolaunch: config.autolaunch,
      firefoxBin: config.firefoxBin,
      profile: launch.profile,
      portWaitSec: config.portWaitSec,
      extraEnv: launch.extraEnv,
      launch,
    });
    if (!res.reachable) {
      logErr(
        `Marionette ${config.marionetteHost}:${launch.port} 不可达。` +
          (res.note ? ` ${res.note}。` : "") +
          (res.command ? ` launch=${res.command}` : "") +
          (res.earlyExit
            ? ` earlyExit=${JSON.stringify({
                code: res.earlyExit.code,
                signal: res.earlyExit.signal,
                error: res.earlyExit.error,
                stderr: res.earlyExit.stderr,
              })}`
            : "") +
          "请确认 Firefox Reverse 已安装、profile 未被其它进程占用；macOS 建议 FRX_FIREFOX_BIN 指向 .app 或 .app/Contents/MacOS/firefox 并设 FRX_AUTOLAUNCH=1。",
      );
    } else {
      logErr(
        `Marionette reachable on ${config.marionetteHost}:${launch.port}` +
          (launch.envId ? ` env=${launch.envId}` : "") +
          (res.launched ? ` (launched via ${res.method || "unknown"})` : "") +
          (res.removedProfileLocks?.length ? ` removedLocks=${res.removedProfileLocks.length}` : ""),
      );
    }
  }

  const bridge = makeBridge(launch.port);
  // Connection is LAZY: we deliberately do NOT connect here. Opening Marionette
  // eagerly would make every idle session grab the single-client lock just by
  // being open. The bridge connects (and acquires the cross-process lock) on the
  // first tool that needs the browser; frx_status reports connectivity on demand.

  const director = new Director(bridge, config);
  const server = new McpServer({ name: "frx-director-mcp", version: "0.3.2" });
  registerTools(server, director);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logErr("工作目录根:", config.workspaceRoot, "| 会话数据:", config.dataDir);
  logErr("ready — tools registered, listening on stdio");

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
