import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerTools } from "../src/server.js";
import { parseToolProfile, profileToolNames, type ToolProfile } from "../src/toolProfiles.js";
import { Director } from "../src/director.js";
import type { Config } from "../src/config.js";
import type { BrowserBridge } from "../src/bridge/BrowserBridge.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function director(toolProfile: ToolProfile) {
  const dataDir = mkdtempSync(join(tmpdir(), "frx-tool-profiles-"));
  directories.push(dataDir);
  const catalog = { count: 3, declaredNames: ["page_click", "page_elements", "net_get"], missingDeclared: [], tools: [
    { name: "page_click", description: "click an element", params: ["selector"], needsConfirm: true },
    { name: "page_elements", description: "find an element", params: ["limit"], needsConfirm: false },
    { name: "net_get", description: "read captured response", params: ["id"], needsConfirm: false },
  ] };
  const bridge = { config: async () => ({ hasKey: false, model: "", provider: "custom", confirmTools: false }), listTools: async () => structuredClone(catalog) } as unknown as BrowserBridge;
  return new Director(bridge, { dataDir, toolProfile } as Config);
}

describe("startup tool profiles", () => {
  it("defaults to all and rejects invalid explicit values", () => {
    expect(parseToolProfile()).toBe("all"); expect(parseToolProfile(" ")).toBe("all");
    expect(parseToolProfile(" direct ")).toBe("direct");
    expect(() => parseToolProfile("diretc")).toThrow("FRX_TOOL_PROFILE");
  });

  for (const [profile, count, unavailable] of [["all", 23, null], ["direct", 13, "agent_start"], ["delegate", 12, "agent_call_tool"]] as const) {
    it(`${profile} exposes exactly its stable tool list over MCP`, async () => {
      const server = new McpServer({ name: "profile-test", version: "1" });
      registerTools(server, director(profile), profile);
      const client = new Client({ name: "test", version: "1" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(a); await client.connect(b);
      try {
        const listed = await client.listTools();
        expect(listed.tools).toHaveLength(count);
        expect(listed.tools.map(tool => tool.name).sort()).toEqual(profileToolNames(profile).sort());
        expect(await client.listTools()).toEqual(listed);
        if (unavailable) {
          const called = await client.callTool({ name: unavailable, arguments: {} });
          expect(called.isError).toBe(true);
        }
        const response = await client.callTool({ name: "agent_tools", arguments: { prefix: "page_", compact: true, limit: 1 } });
        const content = response.content as Array<{ text: string }>;
        const catalog = JSON.parse(content[0]!.text);
        expect(catalog.count).toBe(1); expect(catalog.totalAvailable).toBe(3); expect(catalog.truncated).toBe(true);
        expect(catalog.tools[0]).not.toHaveProperty("description");
      } finally { await client.close(); await server.close(); }
    });
  }

  it("direct readiness does not require a worker key; default behavior is unchanged", async () => {
    expect(await director("direct").status()).toMatchObject({ ready: true, directReady: true, delegateReady: false });
    expect(await director("all").status()).toMatchObject({ ready: false, directReady: true, delegateReady: false });
  });

  it("keeps full catalogs by default and filters without changing the bridge", async () => {
    const d = director("all");
    const full = await d.tools();
    expect(full.count).toBe(3); expect(full.tools[0]).toHaveProperty("description");
    expect(full).not.toHaveProperty("totalAvailable");
    expect((await d.tools({ query: "CAPTURED" })).tools.map(tool => tool.name)).toEqual(["net_get"]);
    expect((await d.tools({ query: "[invalid-regex" })).count).toBe(0);
    expect((await d.tools()).tools).toEqual(full.tools);
  });
});
