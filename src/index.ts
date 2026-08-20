#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./config.js";
import { MarionetteBridge } from "./bridge/MarionetteBridge.js";
import { FileBridge } from "./bridge/FileBridge.js";
import type { BrowserBridge } from "./bridge/BrowserBridge.js";
import { ensureBrowser, resolveBrowserLaunch, type BrowserLaunch } from "./launcher.js";
import { Director, type StartupDiagnostic } from "./director.js";
import { registerTools } from "./server.js";

function makeBridge(port = config.marionettePort): BrowserBridge {
  if (config.bridge === "file") return new FileBridge(config.fileBridgeDir);
  return new MarionetteBridge(config.marionetteHost, port);
}

function fallbackLaunch(): BrowserLaunch {
  return {
    port: config.marionettePort,
    profile: config.profile,
    extraEnv: {},
    envId: config.envId,
    envName: "",
    processLabel: "",
    envPath: "",
    runtimePath: "",
  };
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

async function main(): Promise<void> {
  // stdio transport: all human-readable diagnostics MUST go to stderr (stdout is
  // the MCP JSON-RPC channel).
  const logErr = (...a: unknown[]) => console.error("[frx-director-mcp]", ...a);

  let launch = fallbackLaunch();
  let launchResolveError = "";
  const startup: StartupDiagnostic = {
    phase: "resolving",
    port: launch.port,
    ...(launch.envId ? { envId: launch.envId } : {}),
  };

  if (config.bridge === "marionette") {
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
    } catch (error) {
      launchResolveError = errorText(error);
      startup.phase = "degraded";
      startup.error = `环境启动配置解析失败: ${launchResolveError}`;
      logErr(startup.error);
    }
  } else {
    startup.phase = "ready";
    startup.note = "file bridge ready";
  }

  const bridge = makeBridge(launch.port);
  // Connection is LAZY: we deliberately do NOT connect here. Opening Marionette
  // eagerly would make every idle session grab the single-client lock just by
  // being open. The bridge connects (and acquires the cross-process lock) on the
  // first tool that needs the browser; frx_status reports connectivity on demand.

  const director = new Director(bridge, config, () => ({ ...startup }));
  const server = new McpServer({ name: "frx-director-mcp", version: "0.3.5" });
  registerTools(server, director);

  // MCP stdio 握手必须先于 Firefox 冷启动/Marionette 端口等待。Windows 首启或环境
  // profile 较大时浏览器可能几十秒才 ready；若先 await ensureBrowser，宿主会把 MCP
  // 判为启动超时，最终只剩宿主自己的 open_url 等工具。
  const transport = new StdioServerTransport();
  await server.connect(transport);
  if (config.bridge === "marionette" && !launchResolveError) startup.phase = "registered";
  logErr("ready — MCP tools registered on stdio; browser startup continues independently");
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

  // 工具已经对宿主可见后再探测/拉起浏览器。启动失败只进入 degraded 状态，不能
  // 退出 MCP 进程；用户仍可调用 frx_status 读取具体诊断并修正配置。
  if (config.bridge === "marionette" && !launchResolveError) {
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
      startup.phase = "degraded";
      startup.reachable = false;
      startup.error = `Firefox Reverse 启动失败: ${errorText(error)}`;
      logErr(startup.error);
    }
  }
}

main().catch((e) => {
  console.error("[frx-director-mcp] fatal:", e);
  process.exit(1);
});
