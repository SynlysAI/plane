import { observer } from "mobx-react";
import { useParams, useSearchParams } from "react-router";
import { useWorkspaceContext } from "@/hooks/use-workspace-context";
import { AdministrativeApprovalPanel } from "@/components/administrative/approval-panel";
import { ResearchTodoEnvelopeList } from "@/components/research/common/research-todo-index";
import { ResearchApprovalCenter } from "@/components/research/approvals/research-approval-center";

type ApprovalDomain = "shared_todos" | "administrative" | "research";

type ApprovalDomainTab = {
  id: ApprovalDomain;
  name: string;
};

const APPROVAL_DOMAIN_TABS: ApprovalDomainTab[] = [
  { id: "shared_todos", name: "跨组件待办" },
  { id: "administrative", name: "行政审批" },
];

/** 构造页面级审批域链接参数，仅保留跨域有效的待办范围。 */
function approvalDomainParams(searchParams: URLSearchParams, domain: ApprovalDomain) {
  const params = new URLSearchParams();
  const todoScope = searchParams.get("todo_scope");
  if (todoScope) params.set("todo_scope", todoScope);
  params.set("domain", domain);
  return params;
}

export default observer(function WorkspaceApprovalsPage() {
  const { workspaceSlug } = useParams();
  const { context, error, retry } = useWorkspaceContext();
  const [params, setParams] = useSearchParams();
  if (!workspaceSlug) return null;
  const canResearch = Boolean(
    context?.workspace_enabled &&
    context.capabilities?.nav.some((key) => ["reviews", "reports", "approvals"].includes(key))
  );
  const domainTabs = [...APPROVAL_DOMAIN_TABS, ...(canResearch ? [{ id: "research" as const, name: "科研审批" }] : [])];
  const requestedDomain = params.get("domain") as ApprovalDomain | null;
  const domain =
    requestedDomain && domainTabs.some((tab) => tab.id === requestedDomain)
      ? requestedDomain
      : (domainTabs[0]?.id ?? "administrative");
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-1">
      <h1 className="text-22 px-5 py-4 font-semibold">审批中心</h1>
      <nav aria-label="审批类型" className="flex gap-4 border-b border-subtle px-5">
        {domainTabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`border-b-2 px-2 py-2 text-13 ${item.id === domain ? "border-accent-strong text-primary" : "border-transparent text-secondary"}`}
            aria-current={item.id === domain ? "page" : undefined}
            onClick={() => {
              setParams(approvalDomainParams(params, item.id));
            }}
          >
            {item.name}
          </button>
        ))}
      </nav>
      {error && (
        <p role="alert" className="p-4">
          权限加载失败。
          <button type="button" onClick={retry}>
            重试
          </button>
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {domain === "administrative" ? (
          <AdministrativeApprovalPanel key={workspaceSlug} workspaceSlug={workspaceSlug} />
        ) : domain === "research" ? (
          <ResearchApprovalCenter workspaceSlug={workspaceSlug} />
        ) : (
          <div className="h-full overflow-y-auto bg-canvas p-5">
            <ResearchTodoEnvelopeList workspaceSlug={workspaceSlug} />
          </div>
        )}
      </div>
    </div>
  );
});
