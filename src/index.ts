#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { MarionetteBridge } from "./bridge/MarionetteBridge.js";
import { FileBridge } from "./bridge/FileBridge.js";
import { DeferredBrowserBridge } from "./bridge/DeferredBrowserBridge.js";
import type { BrowserBridge } from "./bridge/BrowserBridge.js";
import { ensureBrowser, resolveBrowserLaunch, type BrowserLaunch } from "./launcher.js";
import { Director, type StartupDiagnostic } from "./director.js";
import { registerTools } from "./server.js";

function makeBridge(port = config.marionettePort): BrowserBridge {
  if (config.bridge === "file") return new FileBridge(config.fileBridgeDir);
  return new MarionetteBridge(config.marionetteHost, port);
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

async function initializeBrowser(
  deferred: DeferredBrowserBridge,
  startup: StartupDiagnostic,
  logErr: (...args: unknown[]) => void,
): Promise<void> {
  if (config.bridge === "file") {
    deferred.setTarget(makeBridge(config.marionettePort));
    startup.phase = "ready";
    startup.note = "file bridge ready";
    return;
  }

  startup.phase = "resolving";
  let launch: BrowserLaunch;
  let concrete: BrowserBridge;
  try {
    launch = await resolveBrowserLaunch({
      host: config.marionetteHost,
      port: config.marionettePort,
      profile: config.profile,
      envId: config.envId,
      envsRoot: config.envsRoot,
    });
    startup.port = launch.port;
    if (launch.envId) startup.envId = launch.envId;
    concrete = makeBridge(launch.port);
  } catch (error) {
    startup.phase = "degraded";
    startup.error = `环境启动配置解析失败: ${errorText(error)}`;
    deferred.setFailure(startup.error);
    logErr(startup.error);
    return;
  }

  startup.phase = "starting";
  try {
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
    startup.launched = res.launched;
    startup.reachable = res.reachable;
    startup.note = res.note;
    startup.phase = res.reachable ? "ready" : "degraded";
    deferred.setTarget(concrete);
    if (!res.reachable) {
      startup.error =
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
          : "");
      logErr(startup.error);
    } else {
      logErr(
        `Marionette reachable on ${config.marionetteHost}:${launch.port}` +
          (launch.envId ? ` env=${launch.envId}` : "") +
          (res.launched ? ` (launched via ${res.method || "unknown"})` : "") +
          (res.removedProfileLocks?.length ? ` removedLocks=${res.removedProfileLocks.length}` : ""),
      );
    }
  } catch (error) {
    deferred.setTarget(concrete);
    startup.phase = "degraded";
    startup.reachable = false;
    startup.error = `Firefox Reverse 启动失败: ${errorText(error)}`;
    logErr(startup.error);
  }
}

async function main(): Promise<void> {
  // stdio transport: all human-readable diagnostics MUST go to stderr (stdout is
  // the MCP JSON-RPC channel).
  const logErr = (...args: unknown[]) => console.error("[frx-director-mcp]", ...args);
  const bridge = new DeferredBrowserBridge();
  const startup: StartupDiagnostic = {
    phase: "registered",
    port: config.marionettePort,
    ...(config.envId ? { envId: config.envId } : {}),
  };

  const director = new Director(bridge, config, () => ({ ...startup }));
  const server = new McpServer({ name: "frx-director-mcp", version: "0.3.6" });
  registerTools(server, director);

  // No environment I/O, port probing or browser launch may precede this line.
  // External hosts can complete initialize/tools-list immediately on every OS.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logErr("ready — MCP tools registered on stdio; environment resolution and browser startup continue independently");
  logErr("工作目录根:", config.workspaceRoot, "| 会话数据:", config.dataDir);

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

  void initializeBrowser(bridge, startup, logErr).catch((error) => {
    startup.phase = "degraded";
    startup.error = `浏览器初始化失败: ${errorText(error)}`;
    bridge.setFailure(startup.error);
    logErr(startup.error);
  });
}

main().catch((e) => {
  console.error("[frx-director-mcp] fatal:", e);
  process.exit(1);
});
