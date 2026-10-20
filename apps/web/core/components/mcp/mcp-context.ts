/** Build the personal MCP settings link without carrying business context. */
export function mcpSettingsPath(workspace?: string) {
  const query = new URLSearchParams();
  if (workspace) query.set("workspace", workspace);
  const search = query.size ? `?${query}` : "";
  return `/settings/profile/mcp/${search}`;
}
