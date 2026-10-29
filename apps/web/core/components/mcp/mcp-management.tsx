import { observer } from "mobx-react";
import { useSearchParams } from "react-router";
import { PageHead } from "@/components/core/page-title";
import { useUser } from "@/hooks/store/user";
import { UnifiedMCPManager } from "./unified-mcp-manager";

export const MCPManagement = observer(function MCPManagement({
  workspaceSlug,
  inModal = false,
}: {
  workspaceSlug?: string;
  inModal?: boolean;
}) {
  const [params] = useSearchParams();
  const { data: user } = useUser();
  const initialWorkspace = inModal ? workspaceSlug : (params.get("workspace") ?? workspaceSlug);
  return (
    <div className="space-y-6 text-13 text-primary">
      <PageHead title="MCP 配置" />
      <header className="space-y-2">
        <h1 className="text-24 font-semibold">MCP 配置</h1>
        <p className="text-secondary">创建一条连接，用一份配置访问授权范围内的行政项目与科研任务。</p>
      </header>
      <UnifiedMCPManager key={user?.id ?? "session"} initialWorkspace={initialWorkspace} />
    </div>
  );
});
