import { describe, expect, it } from "vitest";
import { JS_TOOLS } from "../src/bridge/chromeScripts.js";

type ToolSpec = {
  name: string;
  description: string;
  parameters: { properties: Record<string, unknown> };
  needsConfirm: boolean;
};

const declarations = [
  ["addons_query", "addons", "query"],
  ["addons_manage", "addons", "manage"],
  ["page_click", "page", "click"],
  ["net_get", "net", "get"],
  ["run_node", "workspace", "runNode"],
  ["notes_add", "notes", "add"],
  ["skill_list", "skill", "list"],
  ["remember", "ledger", "add"],
  ["env_list", "env", "list"],
  ["webapi_trace", "webapi", "trace"],
  ["find_param_entry", "find", "paramEntry"],
] as const;

const toolsModule = {
  createBuiltinTools(backends: Record<string, Record<string, unknown>>) {
    return declarations
      .filter(([, backend, method]) => backends[backend]?.[method])
      .map(([name]) => ({
        name,
        description: `${name} description`,
        parameters: { properties: { input: {} } },
        needsConfirm: false,
      })) satisfies ToolSpec[];
  },
  declaredToolNames() {
    return declarations.map(([name]) => name);
  },
};

function executeCatalog(opts: { liveBackends?: Record<string, Record<string, unknown>>; failLive?: boolean }) {
  const ChromeUtils = {
    importESModule(url: string) {
      if (url.endsWith("/Tools.sys.mjs")) return toolsModule;
      if (url.endsWith("/Backends.sys.mjs")) {
        if (opts.failLive) throw new Error("old browser has no Backends export");
        return { getBackends: () => opts.liveBackends || {} };
      }
      throw new Error(`unexpected module: ${url}`);
    },
  };
  return new Function("ChromeUtils", JS_TOOLS)(ChromeUtils) as {
    count: number;
    tools: ToolSpec[];
    declaredNames: string[];
    missingDeclared: string[];
  };
}

describe("browser tool catalog payload", () => {
  it("uses the live backend registry when available", () => {
    const liveBackends = declarations.reduce<Record<string, Record<string, unknown>>>(
      (backends, [, backend, method]) => {
        (backends[backend] ||= {})[method] = () => undefined;
        return backends;
      },
      {},
    );
    const result = executeCatalog({ liveBackends });
    expect(result.count).toBe(declarations.length);
    expect(result.missingDeclared).toEqual([]);
  });

  it("old-browser fallback covers future backend names without a fixed stub list", () => {
    const result = executeCatalog({ failLive: true });
    expect(result.tools.map((tool) => tool.name)).toEqual(declarations.map(([name]) => name));
    expect(result.missingDeclared).toEqual([]);
  });
});
