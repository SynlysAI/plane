import { useParams } from "react-router";
import { MCPApiDocs } from "@/components/mcp/mcp-api-docs";
import { PageHead } from "@/components/core/page-title";
import { AuthenticationWrapper } from "@/lib/wrappers/authentication-wrapper";

export default function ProjectMCPApiDocsPage() {
  const { connectionId } = useParams();
  return (
    <AuthenticationWrapper>
      <PageHead title="项目 MCP API" />
      <MCPApiDocs kind="project" connectionId={connectionId ?? ""} />
    </AuthenticationWrapper>
  );
}
