import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { Button } from "@plane/propel/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import {
  ResearchFilterToolbar,
  ResearchListSurface,
  ResearchTableSurface,
} from "@/components/research/common/research-data-surface";
import { ResearchListState } from "@/components/research/common/research-list-state";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { ProjectDomainsService, domainError, type TAdministrativeApproval } from "@/services/project-domains.service";

import {
  AdministrativeApprovalDetail,
  approvalStatusLabels as statusLabels,
  formatApprovalFlow as formatFlow,
} from "./approval-detail";

const service = new ProjectDomainsService();
export function AdministrativeApprovalPanel({
  workspaceSlug,
  projectId,
}: {
  workspaceSlug: string;
  projectId?: string;
}) {
  const [params, setParams] = useSearchParams();
  const [scope, setScope] = useState(projectId ? "visible" : "related");
  const [items, setItems] = useState<TAdministrativeApproval[]>([]);
  const [detail, setDetail] = useState<TAdministrativeApproval | null>(null);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const requestId = params.get("request");
  const version = useRef(0);
  const load = useCallback(async () => {
    const request = ++version.current;
    setLoading(true);
    setError(null);
    try {
      const [rows, selected] = await Promise.all([
        requestId ? Promise.resolve([]) : service.requests(workspaceSlug, scope, projectId, status),
        requestId ? service.getRequest(workspaceSlug, requestId, projectId) : Promise.resolve(null),
      ]);
      if (request !== version.current) return;
      setItems(rows);
      setDetail(selected);
    } catch (cause) {
      if (request === version.current) setError(domainError(cause));
    } finally {
      if (request === version.current) setLoading(false);
    }
  }, [workspaceSlug, scope, projectId, requestId, status]);
  useEffect(() => {
    setItems([]);
    setDetail(null);
    void load();
    const currentVersion = version;
    return () => {
      currentVersion.current++;
    };
  }, [load]);
  const mutate = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      setComment("");
      await load();
      window.dispatchEvent(new CustomEvent("workspace-todos-updated"));
    } catch (cause) {
      setError(domainError(cause));
    } finally {
      setBusy(false);
    }
  };
  const selectRequest = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("request", id);
    else next.delete("request");
    setComment("");
    setParams(next);
  };
  const filteredItems = items.filter((item) => item.title.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <ResearchListSurface>
      {requestId ? (
        <div>
          <Button variant="secondary" size="xl" disabled={busy} onClick={() => selectRequest(null)}>
            ← 返回审批列表
          </Button>
        </div>
      ) : (
        <p className="text-12 text-secondary">
          {projectId
            ? "查看本项目的审批记录，并处理当前待你审批的事项。"
            : "仅展示你发起的、流程中需要你审批的，以及你已处理的审批，汇总自你可访问的行政项目。"}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary"
        >
          {error}
        </div>
      )}
      {!requestId && (
        <ResearchFilterToolbar>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-12 text-secondary">
              审批事项
              <input
                className="h-8 rounded-md border border-subtle bg-surface-1 px-2 text-13"
                placeholder="搜索审批事项"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-12 text-secondary">
              {projectId ? "项目审批范围" : "与我的关系"}
              <select
                className="h-8 rounded-md border border-subtle bg-surface-1 px-2 text-13"
                value={scope}
                onChange={(event) => setScope(event.target.value)}
              >
                <option value={projectId ? "visible" : "related"}>{projectId ? "本项目全部记录" : "与我相关"}</option>
                <option value="to_me">待我审批</option>
                <option value="mine">我发起的</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-12 text-secondary">
              审批状态
              <select
                className="h-8 rounded-md border border-subtle bg-surface-1 px-2 text-13"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="">全部状态</option>
                <option value="completed">已结束</option>
                {Object.entries(statusLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="secondary" size="xl" disabled={loading} onClick={() => void load()}>
              刷新
            </Button>
          </div>
        </ResearchFilterToolbar>
      )}
      {loading && (
        <ResearchListState
          kind="loading"
          resource="reports"
          config={{ titleKey: "research.common.loading", descriptionKey: "research.common.loading" }}
        />
      )}
      {!loading && detail && (
        <AdministrativeApprovalDetail
          workspaceSlug={workspaceSlug}
          detail={detail}
          comment={comment}
          onCommentChange={setComment}
          busy={busy}
          onAction={(action) => void mutate(() => service.act(workspaceSlug, detail, action, comment))}
        />
      )}
      {!requestId && !loading && !error && (
        <ResearchTableSurface>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>审批事项</TableHead>
                {!projectId && <TableHead>所属项目</TableHead>}
                <TableHead>发起人</TableHead>
                <TableHead>审批方式 / 流程</TableHead>
                <TableHead>当前审批人 / 步骤</TableHead>
                <TableHead>状态</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredItems.map((item) => (
                <TableRow key={item.id} className="align-top">
                  <TableCell className="font-medium text-primary">{item.title}</TableCell>
                  {!projectId && <TableCell className="text-secondary">{item.project_name}</TableCell>}
                  <TableCell className="text-secondary">{item.requester.display_name}</TableCell>
                  <TableCell className="text-tertiary">{formatFlow(item)}</TableCell>
                  <TableCell className="text-tertiary">
                    {item.approvers.map((actor) => actor.display_name).join("、") || "—"}
                    <span className="ml-2">第 {item.step} 步</span>
                  </TableCell>
                  <TableCell>
                    <ResearchStatusBadge status={item.status}>{statusLabels[item.status]}</ResearchStatusBadge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => selectRequest(item.id)}>
                      查看
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {filteredItems.length === 0 && (
                <TableRow>
                  <TableCell colSpan={projectId ? 6 : 7} className="py-10 text-center text-tertiary">
                    {projectId ? "本项目暂无符合筛选条件的审批记录" : "暂无符合筛选条件的个人审批记录"}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ResearchTableSurface>
      )}
    </ResearchListSurface>
  );
}
