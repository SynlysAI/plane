import { Navigate, useSearchParams } from "react-router";
import { mcpSettingsPath } from "./mcp-context";

/** Preserve old management bookmarks while dropping retired research context. */
export function MCPManagementRedirect({ workspaceSlug }: { workspaceSlug?: string }) {
  const [params] = useSearchParams();
  const workspace = workspaceSlug ?? params.get("workspace") ?? undefined;
  return <Navigate replace to={mcpSettingsPath(workspace)} />;
}
