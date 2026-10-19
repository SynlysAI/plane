import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "@plane/propel/button";
import { TabNavigationItem, TabNavigationList } from "@plane/propel/tab-navigation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { ResearchDetailHeader, ResearchDetailSurface, ResearchFilterToolbar, ResearchListSurface, ResearchTableSurface } from "@/components/research/common/research-data-surface";
import { ResearchListState } from "@/components/research/common/research-list-state";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { formatResearchDateTime } from "@/components/research/common/research-format";
import { ProjectDomainsService, domainError, type TAdministrativeApproval, type TAdministrativeFlow, type TProjectApprovalSetting } from "@/services/project-domains.service";
import { ProjectService } from "@/services/project/project.service";

const service = new ProjectDomainsService();
const projectService = new ProjectService();
const statusLabels: Record<string, string> = { PENDING: "审批中", APPROVED: "已通过", REJECTED: "已驳回", WITHDRAWN: "已撤回", CANCELLED: "已取消" };
const actionLabels: Record<string, string> = { SUBMIT: "发起", APPROVE: "同意", REJECT: "驳回", WITHDRAW: "撤回", CANCEL: "取消" };

export function AdministrativeApprovalPanel({ workspaceSlug, projectId }: { workspaceSlug: string; projectId?: string }) {
  const [params, setParams] = useSearchParams();
  const [scope, setScope] = useState(projectId ? "visible" : "to_me");
  const [items, setItems] = useState<TAdministrativeApproval[]>([]);
  const [detail, setDetail] = useState<TAdministrativeApproval | null>(null);
  const [setting, setSetting] = useState<TProjectApprovalSetting | null>(null);
  const [flows, setFlows] = useState<TAdministrativeFlow[]>([]);
  const [flowId, setFlowId] = useState("");
  const [issueId, setIssueId] = useState("");
  const [issueQuery, setIssueQuery] = useState("");
  const [issues, setIssues] = useState<{ id: string; name: string }[]>([]);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const requestId = params.get("request");
  const version = useRef(0);
  const load = useCallback(async () => {
    const request = ++version.current;
    setLoading(true); setError(null);
    try {
      const [rows, selected, config] = await Promise.all([
        service.requests(workspaceSlug, scope, projectId),
        requestId ? service.getRequest(workspaceSlug, requestId) : Promise.resolve(null),
        projectId ? service.projectSetting(workspaceSlug, projectId) : Promise.resolve(null),
      ]);
      const templates = config?.organization_id ? await service.flows(workspaceSlug, config.organization_id) : [];
      if (request !== version.current) return;
      setItems(rows); setDetail(selected); setSetting(config); setFlows(templates); setFlowId(config?.flow_id ?? "");
    } catch (cause) { if (request === version.current) setError(domainError(cause)); }
    finally { if (request === version.current) setLoading(false); }
  }, [workspaceSlug, scope, projectId, requestId]);
  useEffect(() => { setItems([]); setDetail(null); setSetting(null); void load(); return () => { version.current++; }; }, [load]);
  useEffect(() => {
    if (!projectId || !setting?.can_submit) return;
    let active = true;
    const timer = setTimeout(() => {
      void projectService.projectIssuesSearch(workspaceSlug, projectId, { search: issueQuery, workspace_search: false }).then((result) => {
        if (active) setIssues(result);
      }).catch(() => { if (active) setIssues([]); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [workspaceSlug, projectId, issueQuery, setting?.can_submit]);
  const mutate = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); setComment(""); await load(); window.dispatchEvent(new CustomEvent("workspace-todos-updated")); }
    catch (cause) { setError(domainError(cause)); }
    finally { setBusy(false); }
  };
  const selectRequest = (id: string | null) => { const next = new URLSearchParams(params); if (id) next.set("request", id); else next.delete("request"); setParams(next); };
  return (
    <ResearchListSurface>
      {error && <div role="alert" className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary">{error}</div>}
      <ResearchFilterToolbar>
        <div className="flex min-h-8 items-end gap-3">
          <TabNavigationList>{[{ key: "to_me", label: "待我审批" }, { key: "mine", label: "我发起的" }, { key: "visible", label: "项目审批记录" }, { key: "completed", label: "已结束" }].map((item) => <button key={item.key} type="button" onClick={() => setScope(item.key)}><TabNavigationItem isActive={scope === item.key}>{item.label}</TabNavigationItem></button>)}</TabNavigationList>
          <Button variant="secondary" size="xl" className="shrink-0" disabled={loading} onClick={() => void load()}>
            刷新
          </Button>
        </div>
      </ResearchFilterToolbar>
      {setting?.can_manage && projectId && <ResearchDetailSurface title="项目审批配置" hint="审批流程按行政组织隔离；修改流程会创建新版本。"><div className="flex flex-wrap items-center gap-2"><select aria-label="项目审批流程" className="h-8 rounded-md border border-subtle bg-surface-1 px-2 text-13" value={flowId} onChange={(event) => setFlowId(event.target.value)}><option value="">请选择流程</option>{setting.flow_id && !flows.some((flow) => flow.id === setting.flow_id) && <option value={setting.flow_id}>当前已选历史版本</option>}{flows.map((flow) => <option key={flow.id} value={flow.id}>{flow.name} · v{flow.version}</option>)}</select><Button variant="secondary" size="sm" disabled={busy || !flowId} onClick={() => void mutate(() => service.selectFlow(workspaceSlug, projectId, flowId))}>保存流程</Button><Link to={`/${workspaceSlug}/management?tab=administrative`} className="text-12 text-accent-primary hover:underline">管理组织审批流程</Link></div></ResearchDetailSurface>}
      {setting?.can_submit && projectId && <ResearchDetailSurface title="发起行政审批" hint="审批必须绑定当前行政项目中的任务。"><div className="flex flex-wrap items-center gap-2"><input aria-label="搜索待审批任务" placeholder="搜索项目任务" className="h-8 rounded-md border border-subtle bg-surface-1 px-2 text-13" value={issueQuery} onChange={(event) => setIssueQuery(event.target.value)} /><select aria-label="待审批任务" className="h-8 max-w-80 rounded-md border border-subtle bg-surface-1 px-2 text-13" value={issueId} onChange={(event) => setIssueId(event.target.value)}><option value="">选择任务</option>{issues.map((issue) => <option key={issue.id} value={issue.id}>{issue.name}</option>)}</select><Button variant="primary" size="sm" disabled={busy || !issueId || !setting.flow_id} onClick={() => void mutate(async () => { const result = await service.submit(workspaceSlug, projectId, issueId); selectRequest(result.id); })}>发起审批</Button></div></ResearchDetailSurface>}
      {loading && <ResearchListState kind="loading" resource="reports" config={{ titleKey: "research.common.loading", descriptionKey: "research.common.loading" }} />}
      {!loading && detail && <><ResearchDetailHeader title={detail.title} metadata={<><span>{detail.project_name}</span><span>{detail.flow_name} · v{detail.flow_version}</span><ResearchStatusBadge status={detail.status}>{statusLabels[detail.status]}</ResearchStatusBadge></>} actions={<Button variant="ghost" size="sm" onClick={() => selectRequest(null)}>关闭详情</Button>} /><ResearchDetailSurface><div className="space-y-3"><Link to={`/${workspaceSlug}/projects/${detail.project_id}/issues/${detail.issue_id}`} className="text-13 text-accent-primary hover:underline">查看关联任务</Link>{detail.blocked && <p role="alert" className="rounded-md bg-warning-subtle px-3 py-2 text-12 text-warning-primary">当前步骤暂无有效审批人，请联系管理员调整组织或项目权限。</p>}<textarea aria-label="审批意见" placeholder="填写审批意见（驳回、管理取消必填）" className="min-h-20 w-full rounded-md border border-subtle bg-surface-1 p-2 text-13" value={comment} onChange={(event) => setComment(event.target.value)} /><div className="flex flex-wrap gap-2">{[...(detail.can_act ? ["APPROVE", "REJECT"] : []), ...(detail.can_withdraw ? ["WITHDRAW"] : []), ...(detail.can_cancel ? ["CANCEL"] : [])].map((action) => <Button key={action} variant={action === "APPROVE" ? "primary" : "secondary"} size="sm" disabled={busy || (["REJECT", "CANCEL"].includes(action) && !comment.trim())} onClick={() => void mutate(() => service.act(workspaceSlug, detail, action, comment))}>{actionLabels[action]}</Button>)}</div>{detail.history?.length ? <ol className="space-y-2 border-t border-subtle pt-3">{detail.history.map((entry) => <li key={entry.id} className="text-12 text-secondary"><span className="font-medium text-primary">{entry.actor}</span> · {actionLabels[entry.action]} · 第 {entry.step} 步 · {formatResearchDateTime(entry.created_at, "zh-CN")} {entry.comment}</li>)}</ol> : null}</div></ResearchDetailSurface></>}
      {!loading && !detail && !error && <ResearchTableSurface><Table><TableHeader><TableRow><TableHead>审批事项</TableHead><TableHead>项目</TableHead><TableHead>发起人</TableHead><TableHead>审批流程</TableHead><TableHead>当前步骤</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{items.map((item) => <TableRow key={item.id} className="align-top"><TableCell className="font-medium text-primary">{item.title}</TableCell><TableCell className="text-secondary">{item.project_name}</TableCell><TableCell className="text-secondary">{item.requester.display_name}</TableCell><TableCell className="text-tertiary">{item.flow_name} · v{item.flow_version}</TableCell><TableCell className="text-tertiary">第 {item.step} 步</TableCell><TableCell><ResearchStatusBadge status={item.status}>{statusLabels[item.status]}</ResearchStatusBadge></TableCell><TableCell className="text-right"><Button variant="ghost" size="sm" onClick={() => selectRequest(item.id)}>查看</Button></TableCell></TableRow>)}{items.length === 0 && <TableRow><TableCell colSpan={7} className="py-10 text-center text-tertiary">当前没有审批记录</TableCell></TableRow>}</TableBody></Table></ResearchTableSurface>}
    </ResearchListSurface>
  );
}
