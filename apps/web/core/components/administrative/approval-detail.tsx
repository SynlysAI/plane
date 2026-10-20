import { Link } from "react-router";
import { Button } from "@plane/propel/button";
import { getFileURL, isEmptyHtmlString } from "@plane/utils";
import { RichTextEditor } from "@/components/editor/rich-text";
import { ResearchDetailHeader, ResearchDetailSurface } from "@/components/research/common/research-data-surface";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { formatResearchDateTime } from "@/components/research/common/research-format";
import type { TAdministrativeApproval } from "@/services/project-domains.service";

export const approvalStatusLabels: Record<string, string> = {
  PENDING: "审批中",
  APPROVED: "已通过",
  REJECTED: "已驳回",
  WITHDRAWN: "已撤回",
  CANCELLED: "已取消",
};
const actionLabels: Record<string, string> = {
  SUBMIT: "发起",
  APPROVE: "同意",
  REJECT: "驳回",
  WITHDRAW: "撤回",
  CANCEL: "管理取消",
};
const priorityLabels: Record<string, string> = { urgent: "紧急", high: "高", medium: "中", low: "低", none: "无" };
export const formatApprovalFlow = (item: TAdministrativeApproval) =>
  item.approval_mode === "DIRECT" ? "指定审批人" : `${item.flow_name} · v${item.flow_version}`;

/** Review content first; show only actions allowed for this viewer and state. */
export function AdministrativeApprovalDetail({
  workspaceSlug,
  detail,
  comment,
  onCommentChange,
  busy,
  onAction,
}: {
  workspaceSlug: string;
  detail: TAdministrativeApproval;
  comment: string;
  onCommentChange: (value: string) => void;
  busy: boolean;
  onAction: (action: string) => void;
}) {
  const pending = detail.status === "PENDING";
  const canAct = pending && detail.can_act;
  const canWithdraw = pending && detail.can_withdraw;
  const canCancel = pending && detail.can_cancel;
  const actions = [
    ...(canAct ? ["APPROVE", "REJECT"] : []),
    ...(canWithdraw ? ["WITHDRAW"] : []),
    ...(canCancel ? ["CANCEL"] : []),
  ];
  const needsComment = canAct || canCancel;
  const workItem = detail.work_item;
  const viewerHint = !pending
    ? `此审批${approvalStatusLabels[detail.status]}，可查看工作项内容和审批历史。`
    : canAct
      ? "当前轮到你审批，请查看工作项内容后同意或驳回。"
      : canWithdraw
        ? "你是发起人，审批正在处理中；如需修改，可先撤回审批。"
        : canCancel
          ? "你可以查看审批内容，必要时填写原因并管理取消。"
          : "当前无需你处理，可查看工作项内容、审批进度和历史。";
  return (
    <>
      <ResearchDetailHeader
        title={detail.title}
        hint={viewerHint}
        metadata={
          <>
            <span>{detail.project_name}</span>
            <span>发起人：{detail.requester.display_name}</span>
            <span>{formatApprovalFlow(detail)}</span>
            <ResearchStatusBadge status={detail.status}>{approvalStatusLabels[detail.status]}</ResearchStatusBadge>
            <span>发起时间：{formatResearchDateTime(detail.created_at, "zh-CN")}</span>
          </>
        }
      />
      <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <div className="min-w-0 space-y-4">
          <ResearchDetailSurface
            title="工作项内容"
            hint="以下为关联工作项的当前内容。"
            actions={
              <Link
                to={`/${workspaceSlug}/projects/${detail.project_id}/issues/${detail.issue_id}`}
                className="text-12 text-accent-primary hover:underline"
              >
                打开工作项
              </Link>
            }
          >
            {workItem ? (
              <div className="min-w-0 space-y-4">
                <p className="text-12 text-tertiary">{workItem.identifier}</p>
                <h3 className="text-16 font-medium break-words text-primary">{workItem.name}</h3>
                <dl className="grid grid-cols-2 gap-3 border-b border-subtle pb-4 text-12 sm:grid-cols-3">
                  {[
                    ["任务状态", workItem.state || "—"],
                    ["负责人", workItem.assignees.map((actor) => actor.display_name).join("、") || "未指派"],
                    ["优先级", priorityLabels[workItem.priority] || workItem.priority],
                    ["开始日期", workItem.start_date || "—"],
                    ["截止日期", workItem.target_date || "—"],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-tertiary">{label}</dt>
                      <dd className="mt-1 break-words text-primary">{value}</dd>
                    </div>
                  ))}
                </dl>
                {!workItem.description_html ||
                isEmptyHtmlString(workItem.description_html, ["img", "table", "iframe", "video"]) ? (
                  <p className="py-4 text-13 text-tertiary">此工作项暂无详细描述。</p>
                ) : (
                  <RichTextEditor
                    key={workItem.id + detail.updated_at}
                    id={`approval-${detail.id}`}
                    editable={false}
                    initialValue={workItem.description_html}
                    workspaceSlug={workspaceSlug}
                    workspaceId={workItem.workspace_id}
                    projectId={detail.project_id}
                    containerClassName="!p-0 border-none"
                    editorClassName="pl-0"
                  />
                )}
                {workItem.attachments.length > 0 && (
                  <div className="space-y-2 border-t border-subtle pt-3">
                    <h4 className="text-13 font-medium text-primary">附件</h4>
                    {workItem.attachments.map((asset) => (
                      <a
                        key={asset.id}
                        href={getFileURL(asset.url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-13 break-words text-accent-primary hover:underline"
                      >
                        {asset.name}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-13 text-tertiary">工作项内容暂不可用，请打开工作项查看。</p>
            )}
          </ResearchDetailSurface>
          {actions.length > 0 && (
            <ResearchDetailSurface title={canAct ? "审批处理" : canCancel ? "审批管理" : "发起人操作"}>
              <div className="space-y-3">
                {needsComment && (
                  <label className="flex flex-col gap-2 text-13 text-secondary">
                    {canAct ? "审批意见" : "取消原因"}
                    <textarea
                      aria-label={canAct ? "审批意见" : "取消原因"}
                      disabled={busy}
                      placeholder={canAct ? "同意可选填；驳回、管理取消请填写原因" : "请填写管理取消原因"}
                      className="min-h-24 w-full rounded-md border border-subtle bg-surface-1 p-3 text-13"
                      value={comment}
                      onChange={(event) => onCommentChange(event.target.value)}
                    />
                  </label>
                )}
                <div className="flex flex-wrap gap-2">
                  {actions.map((action) => (
                    <Button
                      key={action}
                      variant={action === "APPROVE" ? "primary" : "secondary"}
                      size="xl"
                      disabled={busy || (["REJECT", "CANCEL"].includes(action) && !comment.trim())}
                      onClick={() => onAction(action)}
                    >
                      {actionLabels[action]}
                    </Button>
                  ))}
                </div>
              </div>
            </ResearchDetailSurface>
          )}
        </div>
        <div className="min-w-0 space-y-4">
          <ResearchDetailSurface title="审批进度">
            <div className="space-y-3 text-13">
              {pending && (
                <p className="text-secondary">
                  当前审批人：{detail.approvers.map((actor) => actor.display_name).join("、") || "暂无有效审批人"}
                </p>
              )}
              {detail.blocked && pending && (
                <p role="alert" className="rounded-md bg-warning-subtle px-3 py-2 text-12 text-warning-primary">
                  当前步骤暂无有效审批人，请联系管理员调整组织或项目权限。
                </p>
              )}
              <ol className="space-y-2">
                {detail.steps?.map((step) => (
                  <li
                    key={step.order}
                    className="flex flex-wrap justify-between gap-2 rounded-md border border-subtle p-3"
                  >
                    <span>
                      第 {step.order} 步 · {step.approver_name}
                    </span>
                    <span className="text-12 text-tertiary">
                      {step.order < detail.step || detail.status === "APPROVED"
                        ? "已通过"
                        : step.order === detail.step
                          ? pending
                            ? "当前步骤"
                            : approvalStatusLabels[detail.status]
                          : pending
                            ? "待流转"
                            : "未执行"}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </ResearchDetailSurface>
          <ResearchDetailSurface title="审批历史">
            {detail.history?.length ? (
              <ol className="space-y-3">
                {detail.history.map((entry) => (
                  <li key={entry.id} className="border-b border-subtle pb-3 last:border-0 last:pb-0">
                    <p className="text-13 text-primary">
                      {entry.actor} · {actionLabels[entry.action]} · 第 {entry.step} 步
                    </p>
                    <p className="mt-1 text-11 text-tertiary">{formatResearchDateTime(entry.created_at, "zh-CN")}</p>
                    {entry.comment && (
                      <p className="mt-2 text-13 break-words whitespace-pre-wrap text-secondary">{entry.comment}</p>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-12 text-tertiary">暂无审批历史。</p>
            )}
          </ResearchDetailSurface>
        </div>
      </div>
    </>
  );
}
