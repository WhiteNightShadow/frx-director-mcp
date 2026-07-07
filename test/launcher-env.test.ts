import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFirefoxArgs, buildLaunchCommand, resolveBrowserLaunch } from "../src/launcher.js";

function writeJSON(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2));
}

describe("launcher environment resolution", () => {
  it("uses LaunchServices for macOS app bundles", () => {
    const args = buildFirefoxArgs(2828, "/Users/me/Profile");
    const command = buildLaunchCommand({
      firefoxBin: "/Applications/Firefox Reverse.app/Contents/MacOS/firefox",
      args,
      platform: "darwin",
      processLabel: "Firefox Reverse 1",
    });

    expect(command.method).toBe("macos-open");
    expect(command.command).toBe("open");
    expect(command.browserPidReliable).toBe(false);
    expect(command.args.slice(0, 4)).toEqual(["-n", "-a", "/Applications/Firefox Reverse.app", "--args"]);
    expect(command.args).toContain("-marionette");
    expect(command.args).toContain("-profile");
    expect(command.args).toContain("/Users/me/Profile");
  });

  it("keeps direct executable launch on non-macOS platforms", () => {
    const args = buildFirefoxArgs(2829, "C:\\frx\\profile");
    const command = buildLaunchCommand({
      firefoxBin: "C:\\Program Files\\Firefox Reverse\\firefox.exe",
      args,
      platform: "win32",
      processLabel: "Firefox Reverse 2",
    });

    expect(command.method).toBe("direct");
    expect(command.command).toBe("C:\\Program Files\\Firefox Reverse\\firefox.exe");
    expect(command.argv0).toBe("Firefox Reverse 2");
    expect(command.browserPidReliable).toBe(true);
    expect(command.args).toContain("--marionette-port");
    expect(command.args).toContain("2829");
  });

  it("keeps the legacy profile path when FRX_ENV_ID is unset", async () => {
    const launch = await resolveBrowserLaunch({
      host: "127.0.0.1",
      port: 2828,
      profile: "/tmp/legacy-profile",
      envId: "",
      envsRoot: "/tmp/frx-envs",
    });
    expect(launch.port).toBe(2828);
    expect(launch.profile).toBe("/tmp/legacy-profile");
    expect(launch.extraEnv).toEqual({});
  });

  it("loads env.json, avoids ports already marked as running, and exports MOZ_FRX paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "frx-envs-"));
    const envId = "env_test";
    const basePort = 39280 + Math.floor(Math.random() * 100);
    const envDir = join(root, envId);
    mkdirSync(envDir, { recursive: true });
    writeJSON(join(root, "manifest.json"), {
      schemaVersion: 1,
      environments: [
        { id: "other", runtime: { status: "running", marionettePort: basePort } },
        { id: envId, runtime: { status: "stopped", marionettePort: basePort } },
      ],
    });
    writeJSON(join(envDir, "env.json"), {
      schemaVersion: 1,
      id: envId,
      profilePath: join(envDir, "profile"),
      fingerprintPath: join(envDir, "fingerprint.json"),
      proxyPath: join(envDir, "proxy.json"),
      traceDir: join(envDir, "traces"),
      controlDir: join(envDir, "control"),
      runtime: { status: "stopped", marionettePort: basePort },
    });
    writeJSON(join(envDir, "fingerprint.json"), {
      schemaVersion: 1,
      enabled: true,
      navigator: { webdriver: { enabled: true, value: false } },
    });

    const launch = await resolveBrowserLaunch({
      host: "127.0.0.1",
      port: basePort,
      profile: "",
      envId,
      envsRoot: root,
    });

    expect(launch.envId).toBe(envId);
    expect(launch.profile).toBe(join(envDir, "profile"));
    expect(launch.port).not.toBe(basePort);
    expect(launch.extraEnv.MOZ_FRX_ENV_ID).toBe(envId);
    expect(launch.extraEnv.MOZ_FRX_FINGERPRINT_CONFIG).toBe(join(envDir, "fingerprint.json"));
    expect(JSON.parse(launch.extraEnv.MOZ_FRX_FINGERPRINT_JSON)).toMatchObject({
      enabled: true,
      navigator: { webdriver: { value: false } },
    });

    const saved = JSON.parse(readFileSync(join(envDir, "env.json"), "utf8"));
    expect(saved.runtime.status).toBe("stopped");
    expect(saved.runtime.marionettePort).toBe(launch.port);
  });
});
