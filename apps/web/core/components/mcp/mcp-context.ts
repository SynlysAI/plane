export type TMCPContext = {
  chain?: string | null;
  node?: string | null;
  task?: string | null;
  operation?: string | null;
};

/** Only non-secret location context belongs in a management link. */
export function mcpManagementPath(workspace: string, context: TMCPContext = {}) {
  return mcpSettingsPath(workspace, context, "research");
}

export function mcpSettingsPath(workspace?: string, context: TMCPContext = {}, mode: "native" | "research" = "native") {
  const query = new URLSearchParams({ mode });
  if (workspace) query.set("workspace", workspace);
  for (const key of ["chain", "node", "task", "operation"] as const) {
    if (context[key]) query.set(key, context[key]!);
  }
  return `/settings/profile/mcp/?${query}`;
}
