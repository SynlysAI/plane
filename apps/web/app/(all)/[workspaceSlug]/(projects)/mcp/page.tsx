import { useParams } from "react-router";
import { MCPManagementRedirect } from "@/components/mcp/mcp-management-redirect";

export default function WorkspaceMCPPage() {
  const { workspaceSlug } = useParams();
  return <MCPManagementRedirect workspaceSlug={workspaceSlug} />;
}
