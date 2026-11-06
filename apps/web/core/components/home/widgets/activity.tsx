"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { observer } from "mobx-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import type { THomeActivity, THomeActivityChange, THomeWorkbenchDensity } from "@plane/types";
import { getFileURL } from "@plane/utils";
import { useIntersectionObserver } from "@/hooks/use-intersection-observer";
import { WorkspaceService } from "@/services/workspace.service";

const workspaceService = new WorkspaceService();
/** 首页最近动态固定为轻量的近 30 天口径；更久历史由专门页面承载。 */
const ACTIVITY_DAYS = "30" as const;
const GROUP_WINDOW_MS = 30 * 60 * 1000;
const PRIORITY_CHANGE_FIELDS = ["assignee", "assignees", "status", "due_at", "target_date", "title"];
const ASSIGNEE_CHANGE_FIELDS = new Set(["assignee", "assignees"]);

type Props = {
  workspaceSlug: string;
  density: THomeWorkbenchDensity;
  fixedLayout: boolean;
  refreshToken: number;
};

type TGroupedActivity = THomeActivity & { event_count: number; grouped_ids: string[] };

const NON_GROUPABLE_FIELDS = new Set(["assignee", "status", "member", "role", "comment", "reason"]);

/** Detect whether a historical record contains an explicit old or new value. */
function hasActivityValue(change: THomeActivityChange, key: "old_value" | "new_value"): boolean {
  return Object.prototype.hasOwnProperty.call(change, key);
}

/** Determine whether an activity value represents an absent assignee. */
function isEmptyActivityValue(value: string | null | undefined): boolean {
  return value === null || value === undefined || value === "";
}

/** Format feed timestamps with the active interface language. */
function formatActivityTime(value: string, locale: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "";
  const seconds = (timestamp - Date.now()) / 1000;
  const absoluteSeconds = Math.abs(seconds);
  const [unit, divisor] =
    absoluteSeconds < 60
      ? (["second", 1] as const)
      : absoluteSeconds < 3600
        ? (["minute", 60] as const)
        : absoluteSeconds < 86400
          ? (["hour", 3600] as const)
          : absoluteSeconds < 2592000
            ? (["day", 86400] as const)
            : absoluteSeconds < 31536000
              ? (["month", 2592000] as const)
              : (["year", 31536000] as const);
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(Math.round(seconds / divisor), unit);
}

/** Keep discrete research assignments, lifecycle and discussion events separate. */
function canGroupActivity(activity: THomeActivity): boolean {
  return !activity.changes.some((change) => change.field && NON_GROUPABLE_FIELDS.has(change.field));
}

/** Keep assignment and lifecycle changes visible when a dense row is truncated. */
function prioritizeChanges(activity: THomeActivity, limit: number) {
  return (
    activity.changes
      .map((change, index) => ({ change, index }))
      // map 已生成新数组，原地排序语义等价；项目 TS lib 为 ES2022，暂不使用 toSorted。
      // oxlint-disable-next-line unicorn/no-array-sort
      .sort((left, right) => {
        const leftPriority = PRIORITY_CHANGE_FIELDS.indexOf(left.change.field ?? "");
        const rightPriority = PRIORITY_CHANGE_FIELDS.indexOf(right.change.field ?? "");
        const normalizedLeft = leftPriority === -1 ? PRIORITY_CHANGE_FIELDS.length : leftPriority;
        const normalizedRight = rightPriority === -1 ? PRIORITY_CHANGE_FIELDS.length : rightPriority;
        return normalizedLeft - normalizedRight || left.index - right.index;
      })
      .slice(0, limit)
      .map(({ change }) => change)
  );
}

/** Collapse one removed and one added assignee into a readable replacement. */
function coalesceAssigneeReplacement(changes: THomeActivityChange[]): THomeActivityChange[] {
  const assigneeChanges = changes
    .map((change, index) => ({ change, index }))
    .filter(({ change }) => change.field === "assignees");
  if (assigneeChanges.length !== 2) return changes;

  const removal = assigneeChanges.find(
    ({ change }) => !isEmptyActivityValue(change.old_value) && isEmptyActivityValue(change.new_value)
  );
  const addition = assigneeChanges.find(
    ({ change }) => isEmptyActivityValue(change.old_value) && !isEmptyActivityValue(change.new_value)
  );
  if (!removal || !addition) return changes;

  const replacement: THomeActivityChange = {
    field: "assignee",
    old_value: removal.change.old_value,
    new_value: addition.change.new_value,
  };
  const firstIndex = Math.min(removal.index, addition.index);
  const secondIndex = Math.max(removal.index, addition.index);
  const collapsed = [...changes];
  collapsed[firstIndex] = replacement;
  collapsed.splice(secondIndex, 1);
  return collapsed;
}

/** Merge consecutive identical mutations without losing actors, fields or values. */
function groupActivities(activities: THomeActivity[]): TGroupedActivity[] {
  return activities.reduce<TGroupedActivity[]>((result, activity) => {
    const previous = result.at(-1);
    const sameGroup =
      previous &&
      previous.action === activity.action &&
      previous.entity_id === activity.entity_id &&
      previous.source === activity.source &&
      previous.actor?.id === activity.actor?.id &&
      canGroupActivity(previous) &&
      canGroupActivity(activity) &&
      new Date(previous.occurred_at).getTime() - new Date(activity.occurred_at).getTime() <= GROUP_WINDOW_MS;
    if (sameGroup) {
      const changes = [...previous.changes, ...activity.changes].filter((change, index, all) => {
        const signature = JSON.stringify(change);
        return all.findIndex((item) => JSON.stringify(item) === signature) === index;
      });
      previous.changes = coalesceAssigneeReplacement(changes);
      // 输入按时间倒序，保留较新的发生时间，便于用户判断最近一次协作动作。
      previous.event_count += 1;
      previous.grouped_ids.push(activity.id);
      return result;
    }
    result.push({
      ...activity,
      changes: coalesceAssigneeReplacement([...activity.changes]),
      event_count: 1,
      grouped_ids: [activity.id],
    });
    return result;
  }, []);
}

/** Render the real business mutation stream with progressive pagination. */
export const HomeActivityWidget = observer(function HomeActivityWidget({
  workspaceSlug,
  density,
  fixedLayout,
  refreshToken,
}: Props) {
  const { t, currentLocale } = useTranslation();
  const [cursor, setCursor] = useState<string | null>(null);
  const [activities, setActivities] = useState<THomeActivity[]>([]);
  const [expandedActivityIds, setExpandedActivityIds] = useState<Set<string>>(new Set());
  const [loadMoreElement, setLoadMoreElement] = useState<HTMLDivElement | null>(null);
  const [isLoadMoreVisible, setIsLoadMoreVisible] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const shouldUseCardScroll = fixedLayout;

  /** 绑定分页哨兵，并优先使用所在工作台卡片的内部滚动容器作为观察根。
   * 滚动容器依赖 HomeSectionCard 的 data-home-card-scroll DOM 契约反查；
   * 卡片结构调整会导致回退到浏览器视口观察，分页可能失效，详见 home-section-card.tsx 注释。 */
  const handleLoadMoreElementRef = useCallback(
    (element: HTMLDivElement | null) => {
      setLoadMoreElement(element);
      scrollContainerRef.current = shouldUseCardScroll
        ? (element?.closest("[data-home-card-scroll='true']") ?? null)
        : null;
      setIsLoadMoreVisible(false);
    },
    [shouldUseCardScroll]
  );

  const { data, isLoading, error, mutate } = useSWR(
    workspaceSlug ? ["WORKSPACE_HOME_ACTIVITY", workspaceSlug, ACTIVITY_DAYS, cursor, refreshToken] : null,
    workspaceSlug
      ? () =>
          workspaceService.fetchWorkspaceActivities(workspaceSlug, {
            days: ACTIVITY_DAYS,
            pagination: "cursor",
            cursor: cursor ?? undefined,
            per_page: 12,
          })
      : null,
    { revalidateIfStale: false, revalidateOnFocus: false, revalidateOnReconnect: false }
  );

  useEffect(() => {
    setCursor(null);
    setActivities([]);
    setExpandedActivityIds(new Set());
    setIsLoadMoreVisible(false);
  }, [workspaceSlug, refreshToken]);

  useEffect(() => {
    if (!data) return;
    setActivities((previous) => {
      if (cursor === null) return data.results;
      const seen = new Set(previous.map((item) => item.id));
      return [...previous, ...data.results.filter((item) => !seen.has(item.id))];
    });
  }, [cursor, data]);

  const actionLabels = useMemo(
    () => ({
      created: t("research.activity_actions.created"),
      updated: t("research.activity_actions.updated"),
      deleted: t("research.activity_actions.deleted"),
      archived: t("research.activity_actions.archived"),
      restored: t("research.activity_actions.restored"),
      commented: t("research.activity_actions.commented"),
      comment_updated: t("research.activity_actions.comment_updated"),
      assignment_changed: t("research.activity_actions.assignment_changed"),
      "report.submit": t("research.activity_actions.submitted"),
      "report.create": t("research.activity_actions.created"),
      "report.withdraw": t("research.activity_actions.withdrawn"),
      "report.return": t("research.activity_actions.returned"),
      "report.accept": t("research.activity_actions.accepted"),
      "report.restore": t("research.activity_actions.restored"),
      "report.delete": t("research.activity_actions.deleted"),
      "report.attachment.add": t("research.activity_actions.updated"),
      "report.attachment.delete": t("research.activity_actions.updated"),
      "report.attachment.denied": t("research.activity_actions.updated"),
      "report.import.markdown": t("research.activity_actions.created"),
      "report.export.markdown": t("research.activity_actions.updated"),
      "report.visibility.update": t("research.activity_actions.updated"),
      "report.comment.create": t("research.activity_actions.commented"),
      "report.comment.update": t("research.activity_actions.comment_updated"),
      "report.comment.delete": t("research.activity_actions.deleted"),
      "report.comment.resolve": t("research.activity_actions.resolved_comment"),
      "report.comment.reopen": t("research.activity_actions.reopened_comment"),
      "report.comment.feedback.submit": t("research.activity_actions.submitted_feedback"),
      "task.create": t("research.activity_actions.created"),
      "task.update": t("research.activity_actions.updated"),
      "task.submit": t("research.activity_actions.submitted"),
      "task.return": t("research.activity_actions.returned"),
      "task.withdraw": t("research.activity_actions.withdrawn"),
      "task.complete": t("research.activity_actions.completed"),
      "task.cancel": t("research.activity_actions.cancelled"),
      "task.reopen": t("research.activity_actions.reopened"),
      "task.delete": t("research.activity_actions.deleted"),
      "task.comment.create": t("research.activity_actions.commented"),
      "task.comment.update": t("research.activity_actions.comment_updated"),
      "task.comment.delete": t("research.activity_actions.deleted"),
      "chain.member.add": t("research.activity_actions.member_added"),
      "chain.member.remove": t("research.activity_actions.member_removed"),
      "task.notification_members.update": t("research.activity_actions.updated"),
      "task.instruction.attachment.add": t("research.activity_actions.updated"),
      "task.instruction.attachment.delete": t("research.activity_actions.updated"),
      "task.instruction.attachment.denied": t("research.activity_actions.updated"),
      "task.comment.attachment.add": t("research.activity_actions.updated"),
      "task.comment.attachment.delete": t("research.activity_actions.updated"),
      "task.comment.attachment.denied": t("research.activity_actions.updated"),
      "approval.request.create": t("research.activity_actions.submitted"),
      "approval.approve": t("research.activity_actions.accepted"),
      "approval.reject": t("research.activity_actions.returned"),
      "approval.withdraw": t("research.activity_actions.withdrawn"),
      "approval.cancel": t("research.activity_actions.cancelled"),
      "approval.flow.create": t("research.activity_actions.created"),
      "approval.flow.update": t("research.activity_actions.updated"),
      "project.create": t("research.activity_actions.created"),
      "project.update": t("research.activity_actions.updated"),
      "project.archive": t("research.activity_actions.archived"),
      "project.delete": t("research.activity_actions.deleted"),
      "project.restore": t("research.activity_actions.restored"),
      "project.owner.change": t("research.activity_actions.assignment_changed"),
      "chain.create": t("research.activity_actions.created"),
      "chain.update": t("research.activity_actions.updated"),
      "chain.archive": t("research.activity_actions.archived"),
      "chain.delete": t("research.activity_actions.deleted"),
      "chain.restore": t("research.activity_actions.restored"),
      "chain.export": t("research.activity_actions.updated"),
      "stage.enter": t("research.activity_actions.created"),
      "stage.submit": t("research.activity_actions.submitted"),
      "stage.return": t("research.activity_actions.returned"),
      "stage.pass": t("research.activity_actions.accepted"),
      "stage.reopen": t("research.activity_actions.reopened"),
      "stage.material.create": t("research.activity_actions.created"),
      "stage.material.update": t("research.activity_actions.updated"),
      "stage.material.submit": t("research.activity_actions.submitted"),
      "stage.material.override": t("research.activity_actions.updated"),
      "stage.requirement.update": t("research.activity_actions.updated"),
      "stage.review.assign": t("research.activity_actions.assigned"),
      "stage.review.unassign": t("research.activity_actions.unassigned"),
      "chain.stage.submit": t("research.activity_actions.submitted"),
      "chain.stage.return": t("research.activity_actions.returned"),
      "chain.stage.advisor.approve": t("research.activity_actions.accepted"),
      "chain.stage.pi.approve": t("research.activity_actions.accepted"),
      "chain.stage.advisor.approved": t("research.activity_actions.accepted"),
      "chain.stage.pi.approved": t("research.activity_actions.accepted"),
      "chain.stage.submitted": t("research.activity_actions.submitted"),
      "chain.stage.returned": t("research.activity_actions.returned"),
      "chain.stage.material.add": t("research.activity_actions.created"),
      "chain.stage.material.remove": t("research.activity_actions.deleted"),
      "chain.stage.precheck": t("research.activity_actions.updated"),
      "chain.stage.evaluation.create": t("research.activity_actions.created"),
      "chain.complete": t("research.activity_actions.completed"),
      "stage.review.submit": t("research.activity_actions.submitted"),
      "stage.review.revise": t("research.activity_actions.returned"),
      "stage.review.remind": t("research.activity_actions.updated"),
      "literature.create": t("research.activity_actions.created"),
      "literature.update": t("research.activity_actions.updated"),
      "literature.delete": t("research.activity_actions.deleted"),
      "literature.status": t("research.activity_actions.updated"),
      "literature.import": t("research.activity_actions.created"),
      "literature.pdf": t("research.activity_actions.updated"),
      "experiment.create": t("research.activity_actions.created"),
      "experiment.update": t("research.activity_actions.updated"),
      "experiment.submit": t("research.activity_actions.submitted"),
      "experiment.archive": t("research.activity_actions.archived"),
      "experiment.amendment.create": t("research.activity_actions.created"),
      "experiment.amendment.approve": t("research.activity_actions.accepted"),
      "experiment.amendment.reject": t("research.activity_actions.returned"),
      "experiment.amendment.cancel": t("research.activity_actions.cancelled"),
      "experiment.asset.link": t("research.activity_actions.updated"),
      "experiment.asset.unlink": t("research.activity_actions.updated"),
      "experiment.ingest": t("research.activity_actions.created"),
      "outcome.create": t("research.activity_actions.created"),
      "outcome.update": t("research.activity_actions.updated"),
      "outcome.delete": t("research.activity_actions.deleted"),
      "outcome.link": t("research.activity_actions.updated"),
      "chain.member.update": t("research.activity_actions.updated"),
      "paper.review.create": t("research.activity_actions.created"),
      "paper.version.submit": t("research.activity_actions.submitted"),
      "paper.review.return": t("research.activity_actions.returned"),
      "paper.review.accept": t("research.activity_actions.accepted"),
      "paper.review.withdraw": t("research.activity_actions.withdrawn"),
    }),
    [t]
  );
  const entityTypeLabels = useMemo(
    () => ({
      project: t("research.activity_entities.project"),
      work_item: t("research.activity_entities.work_item"),
      report: t("research.activity_entities.report"),
      report_comment: t("research.activity_entities.comment"),
      research_project: t("research.activity_entities.research_project"),
      research_chain: t("research.activity_entities.research_project"),
      research_chain_node_task: t("research.activity_entities.task"),
      research_chain_stage: t("research.activity_entities.stage"),
      report_attachment: t("research.activity_entities.report"),
      report_comment_feedback: t("research.activity_entities.comment"),
      literature_entry: t("research.activity_entities.literature"),
      experiment_record: t("research.activity_entities.experiment"),
      experiment_amendment: t("research.activity_entities.experiment"),
      research_outcome: t("research.activity_entities.outcome"),
      approval_request: t("research.activity_entities.approval"),
      stage_material: t("research.activity_entities.material"),
      stage_instance: t("research.activity_entities.stage"),
      stage_review_assignment: t("research.activity_entities.review"),
      stage_review: t("research.activity_entities.review"),
      stage_requirement: t("research.activity_entities.material"),
      research_chain_stage_material: t("research.activity_entities.material"),
      research_paper_review: t("research.activity_entities.review"),
      research_paper_review_version: t("research.activity_entities.review"),
    }),
    [t]
  );

  const fieldLabels = useMemo(
    () => ({
      assignee: t("research.activity_fields.assignee"),
      status: t("research.activity_fields.status"),
      title: t("research.activity_fields.title"),
      name: t("research.activity_fields.name"),
      instruction: t("research.activity_fields.instruction"),
      description: t("research.activity_fields.description"),
      due_at: t("research.activity_fields.due_at"),
      target_date: t("research.activity_fields.target_date"),
      start_date: t("research.activity_fields.start_date"),
      priority: t("research.activity_fields.priority"),
      state: t("research.activity_fields.state"),
      assignees: t("research.activity_fields.assignees"),
      resource_type: t("research.activity_fields.resource_type"),
      resource_id: t("research.activity_fields.resource_id"),
      file: t("research.activity_fields.file"),
      member: t("research.activity_fields.member"),
      role: t("research.activity_fields.role"),
      reviewer_role: t("research.activity_fields.role"),
      reviewer: t("research.activity_fields.reviewer"),
      approver: t("research.activity_fields.approver"),
      requester: t("research.activity_fields.requester"),
      visibility: t("research.activity_fields.visibility"),
      comment: t("research.activity_fields.comment"),
      reason: t("research.activity_fields.reason"),
      period: t("research.activity_fields.period"),
      owner: t("research.activity_fields.owner"),
      recommendation: t("research.activity_fields.recommendation"),
      result: t("research.activity_fields.result"),
      version_no: t("research.activity_fields.version_no"),
      change_summary: t("research.activity_fields.change_summary"),
      value: t("research.activity_fields.value"),
    }),
    [t]
  );

  const groupedActivities = useMemo(() => groupActivities(activities), [activities]);
  const visibleChanges = density === "compact" ? 2 : 4;
  const nextCursor = data?.next_cursor ?? null;
  const isFetchingNextPage = isLoading && cursor !== null;
  const hasMorePages = Boolean(data?.has_more && nextCursor) || isFetchingNextPage;
  const canLoadMore = hasMorePages && !isLoading && !error;

  /** 当自动分页哨兵进入视口时请求下一页，并避免重复或失败后连续请求。 */
  const handleLoadMore = useCallback(() => {
    if (!canLoadMore || !nextCursor) return;
    setCursor(nextCursor);
  }, [canLoadMore, nextCursor]);

  useIntersectionObserver(
    scrollContainerRef,
    hasMorePages ? loadMoreElement : null,
    handleLoadMore,
    "120px 0px",
    setIsLoadMoreVisible
  );

  useEffect(() => {
    if (!isLoadMoreVisible) return;
    handleLoadMore();
  }, [handleLoadMore, isLoadMoreVisible]);

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center justify-end gap-2 border-b border-subtle px-4 py-3">
        <button
          type="button"
          className="text-12 text-secondary transition-colors hover:text-primary"
          onClick={() => void mutate()}
        >
          {t("research.common.refresh")}
        </button>
      </div>

      {isLoading && activities.length === 0 && (
        <div className="space-y-2 p-4" role="status" aria-busy="true">
          {[0, 1, 2].map((row) => (
            <div key={row} className="h-10 rounded-md bg-surface-1" />
          ))}
        </div>
      )}
      {error && activities.length === 0 && (
        <p className="p-4 text-12 text-secondary" role="alert">
          {t("research.home_workbench.recent_error")}
        </p>
      )}
      {!isLoading && !error && groupedActivities.length === 0 && (
        <div className="px-4 py-10 text-center">
          <p className="text-13 font-medium text-primary">{t("research.home_workbench.activity_empty_title")}</p>
          <p className="mt-1 text-12 text-tertiary">{t("research.home_workbench.activity_empty_hint")}</p>
        </div>
      )}

      {groupedActivities.length > 0 && (
        <ul className="divide-y divide-subtle" role="list" aria-label={t("research.home_workbench.recent_activity")}>
          {groupedActivities.map((activity) => {
            const entityLabel =
              entityTypeLabels[activity.entity_type as keyof typeof entityTypeLabels] ??
              t("research.activity_entities.business_object");
            const assignmentChange = activity.changes.find(
              (change) => change.field && ASSIGNEE_CHANGE_FIELDS.has(change.field)
            );
            const isAssignment = Boolean(assignmentChange);
            const actionLabel = isAssignment
              ? actionLabels.assignment_changed
              : (actionLabels[activity.action as keyof typeof actionLabels] ?? t("research.activity_actions.updated"));
            const actorName = activity.actor?.display_name ?? t("research.activity_entities.system");
            const fullTime = new Date(activity.occurred_at).toLocaleString(currentLocale);
            const isExpanded = expandedActivityIds.has(activity.id);
            const visibleActivityChanges = isExpanded ? activity.changes : prioritizeChanges(activity, visibleChanges);
            const hasMoreChanges = activity.changes.length > visibleChanges;
            const contextName = activity.project?.name !== activity.entity_name ? activity.project?.name : undefined;
            const fieldLabel = (field?: string | null) =>
              (field && fieldLabels[field as keyof typeof fieldLabels]) || t("research.activity_fields.value");
            const formatValue = (
              value: string | null | undefined,
              side: "old" | "new",
              field?: string | null
            ): string => {
              if (value === null || value === undefined || value === "") {
                return side === "old" ? t("research.activity_values.unset") : t("research.activity_values.cleared");
              }
              if (value === "None" || value === "null") return t("research.activity_values.not_recorded");
              if (field === "due_at") {
                const date = new Date(value);
                if (!Number.isNaN(date.getTime())) return date.toLocaleString(currentLocale);
              }
              if (field === "priority") {
                return (
                  {
                    none: t("research.activity_values.priority_none"),
                    urgent: t("research.activity_values.priority_urgent"),
                    high: t("research.activity_values.priority_high"),
                    medium: t("research.activity_values.priority_medium"),
                    low: t("research.activity_values.priority_low"),
                  }[value.toLowerCase()] ?? value
                );
              }
              return String(value);
            };
            const toggleExpanded = () => {
              setExpandedActivityIds((previous) => {
                const next = new Set(previous);
                if (next.has(activity.id)) next.delete(activity.id);
                else next.add(activity.id);
                return next;
              });
            };
            const content = (
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-13">
                  <span className="text-13 font-medium text-primary">{actorName}</span>
                  <span className="text-secondary">{actionLabel}</span>
                  {isAssignment ? (
                    <>
                      <span className="min-w-0 break-words text-primary">「{activity.entity_name}」</span>
                      <span className="text-secondary">{t("research.activity_sentence.assignee_suffix")}</span>
                    </>
                  ) : (
                    <span className="min-w-0 break-words text-primary">{activity.entity_name}</span>
                  )}
                </div>
                <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-11 text-tertiary">
                  {contextName && <span className="min-w-0 break-words">{contextName}</span>}
                  {contextName && <span aria-hidden="true">·</span>}
                  <span>{entityLabel}</span>
                </div>
                {activity.changes.length > 0 && (
                  <dl className="mt-2 space-y-1 border-l border-subtle pl-3 text-11">
                    {visibleActivityChanges.map((change) => (
                      <div
                        key={`${activity.id}-${change.field ?? "change"}-${change.old_value ?? ""}-${change.new_value ?? ""}`}
                        className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5"
                      >
                        <dt className="text-secondary">{fieldLabel(change.field)}：</dt>
                        {hasActivityValue(change, "old_value") && change.new_value !== "已更新" && (
                          <dd className="min-w-0 break-words text-tertiary">
                            {formatValue(change.old_value, "old", change.field)}
                          </dd>
                        )}
                        {hasActivityValue(change, "old_value") &&
                          change.new_value !== "已更新" &&
                          hasActivityValue(change, "new_value") && (
                            <span className="text-tertiary" aria-hidden="true">
                              →
                            </span>
                          )}
                        {hasActivityValue(change, "new_value") && (
                          <dd className="min-w-0 break-words text-secondary">
                            {formatValue(change.new_value, "new", change.field)}
                          </dd>
                        )}
                      </div>
                    ))}
                  </dl>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-11 text-tertiary">
                  <time dateTime={activity.occurred_at} title={fullTime}>
                    {formatActivityTime(activity.occurred_at, currentLocale)}
                  </time>
                  {activity.event_count > 1 && (
                    <span>{t("research.home_workbench.activity_grouped", { count: activity.event_count })}</span>
                  )}
                </div>
              </div>
            );

            return (
              <li key={activity.id}>
                <div className="px-4 py-3 transition-colors hover:bg-surface-1">
                  {activity.url ? (
                    <Link href={activity.url} className="flex min-w-0 gap-3">
                      {activity.actor ? (
                        <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-1 text-11 font-medium text-secondary">
                          {activity.actor.avatar_url ? (
                            <img
                              src={getFileURL(activity.actor.avatar_url)}
                              alt={actorName}
                              className="size-7 object-cover"
                            />
                          ) : (
                            actorName.slice(0, 1).toUpperCase()
                          )}
                        </span>
                      ) : (
                        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-1 text-11 text-tertiary">
                          {t("research.activity_entities.system").slice(0, 1)}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">{content}</span>
                    </Link>
                  ) : (
                    <article className="flex min-w-0 gap-3">
                      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-1 text-11 text-tertiary">
                        {(activity.actor?.display_name ?? t("research.activity_entities.system"))
                          .slice(0, 1)
                          .toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">{content}</span>
                    </article>
                  )}
                  {hasMoreChanges && (
                    <button
                      type="button"
                      className="mt-1 ml-10 text-11 text-secondary underline-offset-2 hover:underline"
                      onClick={toggleExpanded}
                    >
                      {isExpanded
                        ? t("research.home_workbench.show_less_changes")
                        : t("research.home_workbench.show_more_changes", {
                            count: activity.changes.length - visibleChanges,
                          })}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {hasMorePages && (
        <div
          ref={handleLoadMoreElementRef}
          aria-hidden="true"
          data-testid="activity-auto-load-sentinel"
          className="h-0"
        />
      )}
      {isLoading && activities.length > 0 && (
        <p className="border-t border-subtle px-4 py-3 text-12 text-tertiary" role="status" aria-live="polite">
          {t("research.home_workbench.activity_loading")}
        </p>
      )}
      {error && activities.length > 0 && (
        <p className="border-t border-subtle px-4 py-3 text-12 text-secondary" role="alert">
          {t("research.home_workbench.recent_error")}
        </p>
      )}
    </div>
  );
});
