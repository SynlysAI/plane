import { Navigate, useSearchParams } from "react-router";
import { mcpSettingsPath } from "./mcp-context";

/** Preserve old management bookmarks, forwarding only non-secret location context. */
export function MCPManagementRedirect({ workspaceSlug }: { workspaceSlug?: string }) {
  const [params] = useSearchParams();
  return (
    <Navigate
      replace
      to={mcpSettingsPath(
        workspaceSlug,
        {
          chain: params.get("chain"),
          node: params.get("node"),
          task: params.get("task"),
          operation: params.get("operation"),
        },
        params.get("mode") === "research" || params.has("node") ? "research" : "native"
      )}
    />
  );
}
