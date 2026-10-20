import { useEffect, useState } from "react";
import { Button } from "@plane/propel/button";
import {
  ProjectDomainsService,
  domainError,
  type TAdministrativeApproval,
  type TAdministrativeFlow,
  type TProjectApprovalSetting,
} from "@/services/project-domains.service";
import { ProjectService } from "@/services/project/project.service";

const service = new ProjectDomainsService();
const projectService = new ProjectService();
const fieldClass = "h-8 max-w-80 rounded-md border border-subtle bg-surface-1 px-2 text-13";

/** Select the approver or fixed workflow for a work item. */
export function ApprovalSubmitForm({
  workspaceSlug,
  projectId,
  issueId: fixedIssueId,
  onSubmitted,
}: {
  workspaceSlug: string;
  projectId: string;
  issueId?: string;
  onSubmitted: (approval: TAdministrativeApproval) => void;
}) {
  const [setting, setSetting] = useState<TProjectApprovalSetting | null>(null);
  const [flows, setFlows] = useState<TAdministrativeFlow[]>([]);
  const [mode, setMode] = useState("DIRECT");
  const [approverId, setApproverId] = useState("");
  const [flowId, setFlowId] = useState("");
  const [issueId, setIssueId] = useState("");
  const [query, setQuery] = useState("");
  const [issues, setIssues] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSetting(null);
    setFlows([]);
    setApproverId("");
    setFlowId("");
    setIssueId("");
    setIssues([]);
    setError(null);
    void service
      .projectSetting(workspaceSlug, projectId)
      .then(async (config) => {
        if (!active) return;
        setSetting(config);
        if (config.can_submit && config.organization_id) {
          const templates = await service.flows(workspaceSlug, config.organization_id);
          if (active) setFlows(templates);
        }
        return undefined;
      })
      .catch((cause) => {
        if (active) setError(domainError(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceSlug, projectId]);

  useEffect(() => {
    if (fixedIssueId || !setting?.can_submit) return;
    let active = true;
    const timer = setTimeout(() => {
      void projectService
        .projectIssuesSearch(workspaceSlug, projectId, { search: query, workspace_search: false })
        .then((result) => {
          if (active) setIssues(result);
          return undefined;
        })
        .catch((cause) => {
          if (active) {
            setIssues([]);
            setError(domainError(cause));
          }
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [workspaceSlug, projectId, query, fixedIssueId, setting?.can_submit]);

  if (loading) return <p className="text-12 text-tertiary">正在加载审批选项…</p>;
  if (!setting?.can_submit)
    return error ? (
      <p role="alert" className="text-12 text-danger-primary">
        {error}
      </p>
    ) : null;
  const selectedIssueId = fixedIssueId || issueId;
  const validSelection =
    mode === "DIRECT"
      ? setting.approvers.some((actor) => actor.id === approverId)
      : flows.some((flow) => flow.id === flowId);
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || !selectedIssueId || !validSelection) return;
        setBusy(true);
        setError(null);
        void service
          .submit(
            workspaceSlug,
            projectId,
            selectedIssueId,
            mode === "DIRECT" ? { approver_id: approverId } : { flow_id: flowId }
          )
          .then((approval) => {
            window.dispatchEvent(new CustomEvent("workspace-todos-updated"));
            onSubmitted(approval);
            return undefined;
          })
          .catch((cause) => setError(domainError(cause)))
          .finally(() => setBusy(false));
      }}
    >
      {error && (
        <p role="alert" className="text-12 text-danger-primary">
          {error}
        </p>
      )}
      <fieldset disabled={busy} className="flex flex-wrap items-end gap-3">
        {!fixedIssueId && (
          <>
            <label className="flex flex-col gap-1 text-12 text-secondary">
              搜索任务
              <input
                placeholder="搜索项目任务"
                className={fieldClass}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-12 text-secondary">
              待审批任务
              <select className={fieldClass} value={issueId} onChange={(event) => setIssueId(event.target.value)}>
                <option value="">选择任务</option>
                {issues.map((issue) => (
                  <option key={issue.id} value={issue.id}>
                    {issue.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label className="flex flex-col gap-1 text-12 text-secondary">
          审批方式
          <select className={fieldClass} value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="DIRECT">指定审批人</option>
            <option value="FLOW">固定审批流程</option>
          </select>
        </label>
        {mode === "DIRECT" ? (
          <label className="flex flex-col gap-1 text-12 text-secondary">
            审批人
            <select className={fieldClass} value={approverId} onChange={(event) => setApproverId(event.target.value)}>
              <option value="">请选择审批人</option>
              {setting.approvers.map((actor) => (
                <option key={actor.id} value={actor.id}>
                  {actor.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="flex flex-col gap-1 text-12 text-secondary">
            审批流程
            <select className={fieldClass} value={flowId} onChange={(event) => setFlowId(event.target.value)}>
              <option value="">请选择流程</option>
              {flows.map((flow) => (
                <option key={flow.id} value={flow.id}>
                  {flow.name} · v{flow.version}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button type="submit" variant="primary" size="xl" disabled={busy || !selectedIssueId || !validSelection}>
          {busy ? "正在发起…" : "发起审批"}
        </Button>
      </fieldset>
      {mode === "DIRECT" && !setting.approvers.length && (
        <p className="text-12 text-tertiary">当前项目暂无可用审批人，请联系管理员维护组织和项目成员。</p>
      )}
      {mode === "FLOW" && !flows.length && (
        <p className="text-12 text-tertiary">
          当前组织暂无固定审批流程，可改为指定审批人，或联系管理员在管理页创建流程。
        </p>
      )}
    </form>
  );
}
