import { ResearchAgentOperations } from "@/components/research/chains/research-agent-operations";
import { mcpManagementPath } from "./mcp-context";

export function ResearchNodeMCPEntry({
  workspaceSlug,
  chainId,
  nodeId,
  operationId,
}: {
  workspaceSlug: string;
  chainId: string;
  nodeId: string;
  operationId?: string | null;
}) {
  return (
    <section aria-label="MCP / Agent 操作" className="space-y-2 border-t border-subtle p-4 text-13 text-primary">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-medium">MCP / Agent 操作</h3>
        <a
          className="font-medium text-accent-primary"
          href={mcpManagementPath(workspaceSlug, { chain: chainId, node: nodeId, operation: operationId })}
        >
          管理当前节点连接与提案
        </a>
      </div>
      <p className="text-secondary">在统一 MCP 页面生成节点连接、撤销授权和逐项审核 Agent 提案。</p>
      {/* Historical review_path URLs keep using the same session/CSRF review UI. */}
      {operationId && (
        <ResearchAgentOperations
          key={`${workspaceSlug}:${nodeId}`}
          workspaceSlug={workspaceSlug}
          nodeId={nodeId}
          operationId={operationId}
        />
      )}
    </section>
  );
}
