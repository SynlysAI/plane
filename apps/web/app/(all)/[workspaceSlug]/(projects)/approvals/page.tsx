import { observer } from "mobx-react";
import { useParams, useSearchParams } from "react-router";
import { useWorkspaceContext } from "@/hooks/use-workspace-context";
import { AdministrativeApprovalPanel } from "@/components/administrative/approval-panel";
import { ResearchApprovalCenter } from "@/components/research/approvals/research-approval-center";
export default observer(function WorkspaceApprovalsPage() {
  const { workspaceSlug } = useParams();
  const { context, error, retry } = useWorkspaceContext();
  const [params, setParams] = useSearchParams();
  if (!workspaceSlug) return null;
  const canResearch = Boolean(context?.workspace_enabled && context.capabilities?.nav.some((key) => ["reviews", "reports", "approvals"].includes(key)));
  const domain = params.get("domain") === "research" && canResearch ? "research" : "administrative";
  return <div className="flex h-full min-h-0 flex-col bg-surface-1">
    <h1 className="px-5 py-4 text-22 font-semibold">审批中心</h1>
    <nav aria-label="审批类型" className="flex gap-4 border-b border-subtle px-5">
      {[{ id: "administrative", name: "行政审批" }, ...(canResearch ? [{ id: "research", name: "科研审批" }] : [])].map((item) => <button key={item.id} type="button"
        className={`border-b-2 px-2 py-2 text-13 ${item.id === domain ? "border-accent-strong text-primary" : "border-transparent text-secondary"}`}
        aria-current={item.id === domain ? "page" : undefined} onClick={() => { const next = new URLSearchParams(); next.set("domain", item.id); setParams(next); }}>{item.name}</button>)}
    </nav>
    {error && <p role="alert" className="p-4">权限加载失败。<button type="button" onClick={retry}>重试</button></p>}
    <div className="min-h-0 flex-1 overflow-auto">{domain === "administrative" ? <AdministrativeApprovalPanel key={workspaceSlug} workspaceSlug={workspaceSlug} /> : <ResearchApprovalCenter workspaceSlug={workspaceSlug} />}</div>
  </div>;
});
