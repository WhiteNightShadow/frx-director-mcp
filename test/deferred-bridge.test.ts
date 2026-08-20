import { describe, expect, it, vi } from "vitest";
import { DeferredBrowserBridge } from "../src/bridge/DeferredBrowserBridge.js";
import type { BrowserBridge } from "../src/bridge/BrowserBridge.js";

describe("DeferredBrowserBridge", () => {
  it("fails fast before resolution and delegates after a target is installed", async () => {
    const bridge = new DeferredBrowserBridge();
    expect(() => bridge.listTools()).toThrow(/still resolving/);

    bridge.setFailure("invalid FRX_ENV_ID");
    expect(() => bridge.connect()).toThrow(/invalid FRX_ENV_ID/);

    const connect = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const listTools = vi.fn(async () => ({
      count: 1,
      tools: [],
      declaredNames: ["page_info"],
      missingDeclared: [],
    }));
    const target = { connect, close, listTools } as unknown as BrowserBridge;
    bridge.setTarget(target);

    await bridge.connect();
    expect(connect).toHaveBeenCalledOnce();
    await expect(bridge.listTools()).resolves.toMatchObject({ count: 1 });
    await bridge.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not allow an initialized target to be replaced", () => {
    const bridge = new DeferredBrowserBridge();
    const first = {} as BrowserBridge;
    bridge.setTarget(first);
    expect(() => bridge.setTarget({} as BrowserBridge)).toThrow(/already set/);
    expect(() => bridge.setTarget(first)).not.toThrow();
  });
});
