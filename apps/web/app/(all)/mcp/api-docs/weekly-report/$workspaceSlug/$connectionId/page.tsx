import { useParams } from "react-router";
import { MCPApiDocs } from "@/components/mcp/mcp-api-docs";
import { PageHead } from "@/components/core/page-title";
import { AuthenticationWrapper } from "@/lib/wrappers/authentication-wrapper";

export default function WeeklyReportMCPApiDocsPage() {
  const { connectionId, workspaceSlug } = useParams();
  return (
    <AuthenticationWrapper>
      <PageHead title="周报 MCP API" />
      <MCPApiDocs kind="weekly-report" connectionId={connectionId ?? ""} workspaceSlug={workspaceSlug} />
    </AuthenticationWrapper>
  );
}
