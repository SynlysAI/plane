import { MCPManagementRedirect } from "@/components/mcp/mcp-management-redirect";
import { AuthenticationWrapper } from "@/lib/wrappers/authentication-wrapper";

export default function MCPPage() {
  return (
    <AuthenticationWrapper>
      <MCPManagementRedirect />
    </AuthenticationWrapper>
  );
}
