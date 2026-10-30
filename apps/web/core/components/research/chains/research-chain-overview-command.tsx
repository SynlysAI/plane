"use client";

import { useEffect, useMemo, useState } from "react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type {
  TResearchChain,
  TResearchChainEvent,
  TResearchChainMember,
  TResearchChainNode,
  TResearchChainNodeTask,
  TResearchChainStageApproval,
  TResearchChainStageApprovalSummary,
} from "@plane/types";
// components
import { getResearchErrorDetail } from "@/components/research/common/error-messages";
import { formatResearchDate, formatResearchDateTime } from "@/components/research/common/research-format";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import type { TResearchWorkflowStage } from "@/components/research/chains/research-chain-workflow";
// services
import { ResearchChainService } from "@/services/research/chain.service";
import { ResearchChainTaskService } from "@/services/research/chain-task.service";

type Props = {
  workspaceSlug: string;
  chainId: string;
  chain: TResearchChain | null;
  nodes: TResearchChainNode[];
  members: TResearchChainMember[];
  currentNode: TResearchChainNode | null;
  stages: TResearchWorkflowStage[];
  stageApprovalSummary: TResearchChainStageApprovalSummary | null;
  onOpenStage: (
    stageId: string,
    nodeId: string | null,
    options?: { taskId?: string | null; approval?: boolean }
  ) => void;
  onOpenMembers: () => void;
  onCreateNode: () => void;
  onOpenAgent: (nodeId: string) => void;
  onRefresh: () => Promise<void> | void;
};

type TOpenStageOptions = { taskId?: string | null; approval?: boolean };

const SUBMITTABLE_NODE_STATUSES = new Set<TResearchChainNode["status"]>(["DRAFT", "ACTIVE", "NEEDS_REVISION"]);
const OPEN_TASK_STATUSES = new Set<TResearchChainNodeTask["status"]>(["DRAFT", "ASSIGNED"]);
const chainService = new ResearchChainService();

/** 判断后端是否允许当前用户执行某个阶段动作。 */
function can(stage: TResearchChainStageApproval | null, action: string): boolean {
  return stage?.capabilities?.actions[action]?.allowed ?? false;
}

/** 读取阶段或节点状态的本地化键，兼容旧节点状态回退。 */
function statusLabelKey(status: string): string {
  if (["NOT_STARTED", "IN_PROGRESS", "AWAITING_ADVISOR", "AWAITING_PI", "NEEDS_REVISION", "APPROVED"].includes(status))
    return `research.chains.workflow.stage_status.${status.toLowerCase()}`;
  return `research.chains.node_status.${status.toLowerCase()}`;
}

/** 提取多行审批意见的第一行，避免摘要被长文本撑开。 */
function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0].trim();
}

/** 按阶段序号生成两位数字，保持流程地图的读法一致。 */
function stageIndexLabel(index: number): string {
  return String(index + 1).padStart(2, "0");
}

/** 复制数组后排序，兼容当前运行目标且不修改输入数据。 */
function sortCopy<T>(items: T[], compare: (left: T, right: T) => number): T[] {
  // oxlint-disable-next-line eslint-plugin-unicorn/no-array-sort -- 已先复制数组，避免修改输入数据。
  return items.slice().sort(compare);
}

/**
 * 科研链详情概览指挥台：聚合当前阶段、审批、材料、任务与动态，并把高频操作前移。
 */
export function ResearchChainOverviewCommand({
  workspaceSlug,
  chainId,
  chain,
  nodes,
  members,
  currentNode,
  stages,
  stageApprovalSummary,
  onOpenStage,
  onOpenMembers,
  onCreateNode,
  onOpenAgent,
  onRefresh,
}: Props) {
  const { t, currentLocale } = useTranslation();
  const taskService = useMemo(() => new ResearchChainTaskService(), []);
  const [events, setEvents] = useState<TResearchChainEvent[]>([]);
  const [tasks, setTasks] = useState<TResearchChainNodeTask[]>([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const [returnOpen, setReturnOpen] = useState(false);
  const [returnComment, setReturnComment] = useState("");

  const currentStage =
    stages.find((stage) => stage.isCurrent) ??
    stages.find((stage) => currentNode && stage.nodeIds.includes(currentNode.id)) ??
    null;
  const stageApproval =
    stageApprovalSummary?.stages.find((stage) => stage.stage_code === currentStage?.stageCode) ?? null;
  const stageStatus = stageApproval?.status ?? currentStage?.status ?? "NOT_STARTED";
  const completedMaterials = stageApproval?.materials.filter((material) => material.complete).length ?? 0;
  const missingMaterials = stageApproval?.materials.filter((material) => !material.complete) ?? [];
  const totalMaterials = stageApproval?.materials.length ?? 0;
  const canEditMaterials = can(stageApproval, "edit_materials");
  const canSubmitStage = can(stageApproval, "submit");
  const canReviewStage = can(stageApproval, "review");
  const awaitingReview = stageApproval?.status === "AWAITING_ADVISOR" || stageApproval?.status === "AWAITING_PI";
  const nodeSubmittable = Boolean(currentNode && SUBMITTABLE_NODE_STATUSES.has(currentNode.status));
  const precheckReady =
    stageApproval?.stage_code !== "TOPIC_EVALUATION" || (stageApproval?.latest_precheck?.is_current ?? false);
  const materialReady = missingMaterials.length === 0 && nodeSubmittable && precheckReady;
  const showSubmit = canSubmitStage && materialReady;
  const showReview = canReviewStage && awaitingReview;
  const openTasks = useMemo(() => tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status)), [tasks]);
  const topTasks = openTasks.slice(0, 3);
  // 复制后再排序，兼容当前 ES2022 运行目标。
  const recentEvents = useMemo(
    () => sortCopy(events, (left, right) => right.occurred_at.localeCompare(left.occurred_at)).slice(0, 5),
    [events]
  );
  const latestReview = stageApproval?.review_actions?.[stageApproval.review_actions.length - 1] ?? null;
  // Owner 置前并截断展示，其余成员以计数折叠。
  const summaryMembers = useMemo(
    () => sortCopy(members, (left, right) => Number(right.is_owner) - Number(left.is_owner)).slice(0, 5),
    [members]
  );
  const hiddenMemberCount = Math.max(members.length - summaryMembers.length, 0);

  useEffect(() => {
    if (!currentNode) {
      setEvents([]);
      setTasks([]);
      setActivityLoading(false);
      setActivityError(false);
      return;
    }
    let active = true;
    setActivityLoading(true);
    setActivityError(false);
    void (async () => {
      const [detailResult, taskResult] = await Promise.allSettled([
        chainService.getChainNodeDetail(workspaceSlug, currentNode.id),
        taskService.getNodeTasks(workspaceSlug, chainId, currentNode.id),
      ]);
      if (!active) return;
      setEvents(detailResult.status === "fulfilled" ? detailResult.value.events : []);
      setTasks(taskResult.status === "fulfilled" ? taskResult.value : []);
      setActivityError(detailResult.status === "rejected" || taskResult.status === "rejected");
      setActivityLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [chainId, currentNode, taskService, workspaceSlug]);

  /** 提交当前阶段进入审核，并把结果交回详情页刷新。 */
  const submitStage = async () => {
    if (!stageApproval || !currentNode || actionBusy) return;
    setActionBusy(true);
    setActionError("");
    try {
      await chainService.submitChainStage(workspaceSlug, chainId, stageApproval.stage_code, {
        node_id: currentNode.id,
        requires_pi: stageApproval.requires_pi || undefined,
      });
      await onRefresh();
    } catch (error) {
      setActionError(getResearchErrorDetail(error) ?? t("research.chains.stage_approval.action_failed"));
    } finally {
      setActionBusy(false);
    }
  };

  /** 执行阶段审批；驳回必须携带审批意见。 */
  const reviewStage = async (intent: "APPROVE" | "RETURN") => {
    if (!stageApproval || actionBusy) return;
    if (intent === "RETURN" && !returnComment.trim()) {
      setActionError(t("research.chains.overview.review_comment_required"));
      return;
    }
    setActionBusy(true);
    setActionError("");
    try {
      await chainService.reviewChainStage(workspaceSlug, chainId, stageApproval.stage_code, {
        action: intent,
        comment: intent === "RETURN" ? returnComment.trim() : undefined,
      });
      setReturnOpen(false);
      setReturnComment("");
      await onRefresh();
    } catch (error) {
      setActionError(getResearchErrorDetail(error) ?? t("research.chains.stage_approval.action_failed"));
    } finally {
      setActionBusy(false);
    }
  };

  const handlerName = awaitingReview
    ? stageApproval?.status === "AWAITING_PI"
      ? (stageApproval.principal_investigator.user?.display_name ?? stageApproval.principal_investigator.error ?? "-")
      : (stageApproval?.advisor.user?.display_name ?? stageApproval?.advisor.error ?? "-")
    : (chain?.owner_name ?? "-");
  const pendingItems = [
    {
      label: t("research.chains.workflow.stage_status.awaiting_advisor"),
      count: stageApprovalSummary?.progress.awaiting_advisor ?? 0,
    },
    {
      label: t("research.chains.workflow.stage_status.awaiting_pi"),
      count: stageApprovalSummary?.progress.awaiting_pi ?? 0,
    },
    {
      label: t("research.chains.workflow.stage_status.needs_revision"),
      count: stageApprovalSummary?.progress.needs_revision ?? 0,
    },
  ].filter((item) => item.count > 0);

  const openCurrentStage = (options?: TOpenStageOptions) => {
    if (currentStage) onOpenStage(currentStage.id, currentNode?.id ?? null, options);
  };

  return (
    <div className="bg-surface-1" data-research-overview-command="">
      <section
        className="border-b border-subtle bg-surface-1 px-5 py-3"
        aria-label={t("research.chains.overview.actions_title")}
      >
        <div className="flex flex-wrap items-center gap-2">
          {currentNode && currentStage && (
            <Button variant="primary" size="base" onClick={() => openCurrentStage()}>
              {t("research.chains.overview.continue_stage")}
            </Button>
          )}
          {showSubmit && (
            <Button variant="secondary" size="base" disabled={actionBusy} onClick={() => void submitStage()}>
              {t("research.chains.overview.submit_stage")}
            </Button>
          )}
          {showReview && (
            <>
              <Button variant="primary" size="base" disabled={actionBusy} onClick={() => void reviewStage("APPROVE")}>
                {t("research.chains.stage_approval.approve")}
              </Button>
              <Button
                variant="secondary"
                size="base"
                disabled={actionBusy}
                onClick={() => {
                  setReturnOpen(true);
                  setActionError("");
                }}
              >
                {t("research.chains.stage_approval.return")}
              </Button>
            </>
          )}
          {currentNode && (
            <Button variant="secondary" size="base" onClick={() => onOpenAgent(currentNode.id)}>
              {t("research.chains.open_agent")}
            </Button>
          )}
        </div>
        {actionError && !returnOpen && (
          <p className="mt-2 text-12 text-danger-primary" role="alert">
            {actionError}
          </p>
        )}
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0">
          <section className="px-5 py-5" aria-label={t("research.chains.overview.current_stage")}>
            {currentNode && currentStage ? (
              <>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h4 className="text-14 font-semibold text-primary">
                    <span className="font-normal mr-2 text-11 text-tertiary tabular-nums">
                      {stageIndexLabel(stages.indexOf(currentStage))}
                    </span>
                    {t(currentStage.labelKey)}
                  </h4>
                  <span className="text-12 text-secondary">{t(statusLabelKey(stageStatus))}</span>
                </div>
                <div className="border-accent-primary mt-4 border-l-2 pl-4">
                  <p className="text-11 text-tertiary">{t("research.chains.current_node")}</p>
                  <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-13 font-medium text-primary">{currentNode.title}</span>
                    <ResearchStatusBadge status={currentNode.status} size="sm">
                      {t(`research.chains.node_status.${currentNode.status.toLowerCase()}`)}
                    </ResearchStatusBadge>
                  </div>
                </div>
                <dl className="mt-4 space-y-4 text-12">
                  <div className="grid grid-cols-[minmax(6.5rem,8.5rem)_minmax(0,1fr)] items-start gap-x-4 gap-y-1">
                    <dt className="leading-6 text-tertiary">
                      {awaitingReview
                        ? t("research.chains.stage_approval.current_handler")
                        : t("research.chains.stage_approval.applicant")}
                    </dt>
                    <dd className="min-w-0 truncate text-13 leading-6 text-primary">{handlerName}</dd>
                  </div>
                  <div className="grid grid-cols-[minmax(6.5rem,8.5rem)_minmax(0,1fr)] items-start gap-x-4 gap-y-1">
                    <dt className="leading-6 text-tertiary">{t("research.chains.stage_approval.materials")}</dt>
                    <dd className="min-w-0 text-13 leading-6 text-primary">
                      <span className="tabular-nums">
                        {t("research.chains.stage_approval.summary_materials", {
                          completed: completedMaterials,
                          total: totalMaterials,
                        })}
                      </span>
                      {missingMaterials.length > 0 && (
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                          {canEditMaterials && (
                            <button
                              type="button"
                              className="text-12 text-secondary transition-colors duration-150 hover:text-accent-primary"
                              onClick={() => openCurrentStage({ approval: true })}
                            >
                              {t("research.chains.overview.supplement_materials")}
                            </button>
                          )}
                          <p className="text-11 text-tertiary">
                            {t("research.chains.stage_approval.missing_summary", {
                              count: missingMaterials.length,
                            })}
                          </p>
                        </div>
                      )}
                    </dd>
                  </div>
                  <div className="grid grid-cols-[minmax(6.5rem,8.5rem)_minmax(0,1fr)] items-start gap-x-4 gap-y-1">
                    <dt className="leading-6 text-tertiary">{t("research.chains.overview.todo_tasks")}</dt>
                    <dd className="min-w-0">
                      {topTasks.length > 0 ? (
                        <ul role="list">
                          {topTasks.map((task) => (
                            <li key={task.id}>
                              <button
                                type="button"
                                className="flex w-full items-center justify-between gap-3 rounded-md py-2 text-left transition-colors duration-150 hover:bg-layer-1-hover"
                                onClick={() => openCurrentStage({ taskId: task.id })}
                              >
                                <span className="min-w-0 truncate text-13 text-primary">{task.title}</span>
                                <span className="shrink-0 text-11 text-tertiary">
                                  {task.due_at
                                    ? t("research.chains.overview.todo_task_due", {
                                        date: formatResearchDate(task.due_at, currentLocale),
                                      })
                                    : (task.assignee_detail?.display_name ?? "")}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-12 text-tertiary">{t("research.chains.overview.todo_tasks_empty")}</p>
                      )}
                      {openTasks.length > topTasks.length && (
                        <button
                          type="button"
                          className="mt-1.5 text-12 text-secondary transition-colors duration-150 hover:text-accent-primary"
                          onClick={() => openCurrentStage()}
                        >
                          {t("research.chains.overview.todo_tasks_more", { count: openTasks.length })}
                        </button>
                      )}
                    </dd>
                  </div>
                  <div className="grid grid-cols-[minmax(6.5rem,8.5rem)_minmax(0,1fr)] items-start gap-x-4 gap-y-1">
                    <dt className="leading-6 text-tertiary">{t("research.chains.overview.latest_review")}</dt>
                    <dd className="min-w-0">
                      {latestReview ? (
                        <p className="text-13 leading-6 text-secondary">
                          {t("research.chains.overview.latest_review_result", {
                            action:
                              latestReview.action === "APPROVE"
                                ? t("research.chains.stage_approval.approve")
                                : t("research.chains.stage_approval.return"),
                            comment: firstLine(latestReview.comment) || "-",
                          })}
                          <span className="ml-2 text-11 text-tertiary">
                            {formatResearchDateTime(latestReview.created_at, currentLocale)}
                          </span>
                        </p>
                      ) : (
                        <p className="text-12 text-tertiary">{t("research.chains.overview.no_review")}</p>
                      )}
                    </dd>
                  </div>
                </dl>
              </>
            ) : (
              <div className="py-2">
                <h4 className="text-14 font-semibold text-primary">{t("research.chains.overview.current_stage")}</h4>
                <p className="mt-2 text-12 text-secondary">{t("research.chains.overview.no_current_node")}</p>
                <p className="mt-1 text-12 text-tertiary">{t("research.chains.overview.no_current_node_hint")}</p>
                <Button variant="secondary" size="sm" className="mt-3" onClick={onCreateNode}>
                  {t("research.chains.create_node")}
                </Button>
              </div>
            )}
          </section>

          <section
            className="border-t border-subtle px-5 py-5"
            aria-label={t("research.chains.overview.recent_activity")}
          >
            <h4 className="text-14 font-semibold text-primary">{t("research.chains.overview.recent_activity")}</h4>
            {activityLoading && (
              <p className="mt-2 text-12 text-tertiary">{t("research.chains.overview.activity_loading")}</p>
            )}
            {!activityLoading && recentEvents.length === 0 && (
              <p className="mt-2 text-12 text-tertiary">{t("research.chains.overview.activity_empty")}</p>
            )}
            {!activityLoading && activityError && (
              <p className="mt-1 text-11 text-tertiary">{t("research.chains.overview.overview_partial_error")}</p>
            )}
            {recentEvents.length > 0 && (
              <ul className="mt-2 divide-y divide-subtle" role="list">
                {recentEvents.map((event) => (
                  <li key={event.event_id}>
                    <button
                      type="button"
                      className="flex w-full items-start justify-between gap-4 rounded-md py-2.5 text-left transition-colors duration-150 hover:bg-layer-1-hover"
                      onClick={() => openCurrentStage()}
                    >
                      <span className="min-w-0 flex-1 truncate text-13 text-primary">{event.summary}</span>
                      <span className="shrink-0 text-11 text-tertiary">
                        {formatResearchDateTime(event.occurred_at, currentLocale)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="space-y-5 border-t border-subtle bg-layer-1 px-4 py-5 xl:border-t-0 xl:border-l">
          <section>
            <h4 className="text-12 font-semibold text-primary">{t("research.chains.overview.metrics")}</h4>
            <dl className="mt-3 space-y-3 text-12">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-tertiary">{t("research.chains.stage_approval.title")}</dt>
                <dd className="text-13 font-semibold text-primary tabular-nums">
                  {t("research.chains.stage_approval.progress", {
                    approved: stageApprovalSummary?.progress.approved ?? 0,
                    total: stageApprovalSummary?.progress.total ?? 0,
                  })}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="text-tertiary">{t("research.chains.overview.approval_pending")}</dt>
                <dd className="min-w-0 text-right text-13 font-medium text-primary">
                  {pendingItems.length > 0
                    ? pendingItems.map((item) => `${item.label} ${item.count}`).join(" · ")
                    : t("research.chains.stage_approval.no_pending")}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-tertiary">{t("research.chains.overview.node_summary")}</dt>
                <dd className="text-right text-13 font-medium text-primary tabular-nums">
                  {t("research.chains.overview.node_count", { count: nodes.length })} ·{" "}
                  {t("research.chains.overview.member_count", { count: members.length })}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-tertiary">{t("research.chains.updated_at")}</dt>
                <dd className="text-right text-13 font-medium text-primary tabular-nums">
                  {chain ? formatResearchDateTime(chain.updated_at, currentLocale) : "-"}
                </dd>
              </div>
            </dl>
          </section>

          <section>
            <h4 className="text-12 font-semibold text-primary">{t("research.chains.overview.members_title")}</h4>
            {members.length > 0 ? (
              <>
                <p className="mt-2 truncate text-13 text-primary">
                  {summaryMembers.map((member) => member.display_name).join(" · ")}
                  {hiddenMemberCount > 0 &&
                    ` ${t("research.chains.overview.more_members", { count: hiddenMemberCount })}`}
                </p>
                <button
                  type="button"
                  className="mt-1.5 text-12 text-secondary transition-colors duration-150 hover:text-accent-primary"
                  onClick={onOpenMembers}
                >
                  {t("research.chains.overview.manage_members")}
                </button>
              </>
            ) : (
              <p className="mt-2 text-12 text-tertiary">{t("research.chains.members.empty")}</p>
            )}
          </section>

          <section>
            <h4 className="text-12 font-semibold text-primary">{t("research.chains.overview.quick_entries")}</h4>
            <div className="mt-2 flex flex-wrap gap-2">
              {currentStage && (
                <Button variant="secondary" size="sm" onClick={() => openCurrentStage()}>
                  {t("research.chains.overview.node_workspace")}
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={onCreateNode}>
                {t("research.chains.overview.create_node_entry")}
              </Button>
              <Button variant="secondary" size="sm" onClick={onOpenMembers}>
                {t("research.chains.overview.manage_members")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void onRefresh()}>
                {t("research.chains.refresh")}
              </Button>
            </div>
          </section>
        </aside>
      </div>

      {returnOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t("research.chains.stage_approval.return")}
          data-stage-return-dialog=""
          className="fixed inset-0 z-40 flex items-center justify-center bg-backdrop p-4"
        >
          <form
            className="w-full max-w-md rounded-lg border border-subtle bg-surface-1 p-5"
            onSubmit={(event) => {
              event.preventDefault();
              void reviewStage("RETURN");
            }}
          >
            <h3 className="text-16 font-semibold text-primary">{t("research.chains.stage_approval.return")}</h3>
            <label className="mt-4 flex flex-col gap-1 text-11 text-tertiary">
              <span>{t("research.chains.stage_approval.review_comment")}</span>
              <textarea
                value={returnComment}
                rows={3}
                aria-invalid={Boolean(actionError)}
                onChange={(event) => setReturnComment(event.target.value)}
                className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
              />
            </label>
            {actionError && (
              <p className="mt-2 text-12 text-danger-primary" role="alert">
                {actionError}
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <Button variant="primary" size="sm" type="submit" disabled={actionBusy}>
                {t("research.chains.overview.confirm_return")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setReturnOpen(false);
                  setReturnComment("");
                  setActionError("");
                }}
              >
                {t("research.chain_tasks.cancel_edit")}
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
