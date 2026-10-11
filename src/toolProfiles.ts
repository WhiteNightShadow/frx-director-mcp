export const TOOL_PROFILES = ["all", "direct", "delegate"] as const;
export type ToolProfile = typeof TOOL_PROFILES[number];

export const COMMON_TOOLS = ["frx_status", "agent_tools"] as const;
export const DIRECT_TOOLS = [
  "frx_env_current", "frx_env_list", "frx_env_create", "frx_env_rename", "frx_env_open",
  "frx_env_close", "frx_env_delete", "frx_env_import_json", "frx_env_import_capture",
  "frx_page_automation_scan", "agent_call_tool",
] as const;
export const DELEGATE_TOOLS = [
  "agent_start", "agent_wait_for_stop", "agent_poll", "agent_read", "agent_read_brief",
  "agent_state", "agent_send", "agent_set_mode", "agent_stop", "agent_runlog",
] as const;

export function parseToolProfile(value?: string): ToolProfile {
  const profile = value?.trim() || "all";
  if (!TOOL_PROFILES.includes(profile as ToolProfile)) {
    throw new Error("FRX_TOOL_PROFILE must be all, direct or delegate");
  }
  return profile as ToolProfile;
}

export function profileToolNames(profile: ToolProfile): string[] {
  return [...COMMON_TOOLS, ...(profile !== "delegate" ? DIRECT_TOOLS : []),
    ...(profile !== "direct" ? DELEGATE_TOOLS : [])];
}
