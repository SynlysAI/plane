"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { observer } from "mobx-react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import type { THomeActivity, THomeWorkbenchDensity } from "@plane/types";
import { calculateTimeAgo, cn, getFileURL } from "@plane/utils";
import { useIntersectionObserver } from "@/hooks/use-intersection-observer";
import { WorkspaceService } from "@/services/workspace.service";

const workspaceService = new WorkspaceService();
const DAY_OPTIONS = [
  { value: "30" as const, labelKey: "research.overview.period_30" },
  { value: "90" as const, labelKey: "research.overview.period_90" },
  { value: "all" as const, labelKey: "research.overview.period_all" },
];
const GROUP_WINDOW_MS = 30 * 60 * 1000;

type Props = {
  workspaceSlug: string;
  density: THomeWorkbenchDensity;
  refreshToken: number;
};

type TGroupedActivity = THomeActivity & { event_count: number; grouped_ids: string[] };

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
      new Date(previous.occurred_at).getTime() - new Date(activity.occurred_at).getTime() <= GROUP_WINDOW_MS;
    if (sameGroup) {
      const changes = [...previous.changes, ...activity.changes].filter((change, index, all) => {
        const signature = JSON.stringify(change);
        return all.findIndex((item) => JSON.stringify(item) === signature) === index;
      });
      previous.changes = changes;
      // 输入按时间倒序，保留较新的发生时间，便于用户判断最近一次协作动作。
      previous.event_count += 1;
      previous.grouped_ids.push(activity.id);
      return result;
    }
    result.push({ ...activity, changes: [...activity.changes], event_count: 1, grouped_ids: [activity.id] });
    return result;
  }, []);
}

/** Render the real business mutation stream with progressive pagination. */
export const HomeActivityWidget = observer(function HomeActivityWidget({
  workspaceSlug,
  density,
  refreshToken,
}: Props) {
  const { t, currentLocale } = useTranslation();
  const [days, setDays] = useState<"30" | "90" | "all">("30");
  const [offset, setOffset] = useState(0);
  const [activities, setActivities] = useState<THomeActivity[]>([]);
  const [loadMoreElement, setLoadMoreElement] = useState<HTMLDivElement | null>(null);
  // 保持 ref 为空，让 IntersectionObserver 使用浏览器视口，同时兼容卡片内滚动与页面滚动。
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const { data, isLoading, error, mutate } = useSWR(
    workspaceSlug ? ["WORKSPACE_HOME_ACTIVITY", workspaceSlug, days, offset, refreshToken] : null,
    workspaceSlug
      ? () =>
          workspaceService.fetchWorkspaceActivities(workspaceSlug, {
            days,
            offset,
            per_page: 12,
          })
      : null,
    { revalidateIfStale: false, revalidateOnFocus: false, revalidateOnReconnect: false }
  );

  useEffect(() => {
    setOffset(0);
    setActivities([]);
  }, [days, workspaceSlug, refreshToken]);

  useEffect(() => {
    if (!data) return;
    setActivities((previous) => {
      if (data.offset === 0) return data.results;
      const seen = new Set(previous.map((item) => item.id));
      return [...previous, ...data.results.filter((item) => !seen.has(item.id))];
    });
  }, [data]);

  const actionLabels = useMemo(
    () => ({
      created: t("research.activity_actions.created"),
      updated: t("research.activity_actions.updated"),
      deleted: t("research.activity_actions.deleted"),
      archived: t("research.activity_actions.archived"),
      restored: t("research.activity_actions.restored"),
      commented: t("research.activity_actions.commented"),
      comment_updated: t("research.activity_actions.comment_updated"),
      "report.submit": t("research.activity_actions.submitted"),
      "report.return": t("research.activity_actions.returned"),
      "report.accept": t("research.activity_actions.accepted"),
      "report.comment.create": t("research.activity_actions.commented"),
      "report.comment.update": t("research.activity_actions.comment_updated"),
      "report.comment.resolve": t("research.activity_actions.resolved_comment"),
      "report.comment.reopen": t("research.activity_actions.reopened_comment"),
      "report.comment.feedback.submit": t("research.activity_actions.submitted_feedback"),
      "task.create": t("research.activity_actions.created"),
      "task.update": t("research.activity_actions.updated"),
      "task.submit": t("research.activity_actions.submitted"),
      "task.return": t("research.activity_actions.returned"),
      "task.complete": t("research.activity_actions.completed"),
      "task.cancel": t("research.activity_actions.cancelled"),
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
      literature_entry: t("research.activity_entities.literature"),
      experiment_record: t("research.activity_entities.experiment"),
      research_outcome: t("research.activity_entities.outcome"),
    }),
    [t]
  );

  const groupedActivities = useMemo(() => groupActivities(activities), [activities]);
  const visibleChanges = density === "compact" ? 2 : 4;
  const canLoadMore = Boolean(data?.has_more) && !isLoading && !error;

  /** 当自动分页哨兵进入视口时请求下一页，并避免重复或失败后连续请求。 */
  const handleLoadMore = () => {
    if (!data?.has_more || isLoading || error) return;
    setOffset(data.next_offset ?? offset + 1);
  };

  useIntersectionObserver(viewportRef, canLoadMore ? loadMoreElement : null, handleLoadMore, "120px 0px");

  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-subtle px-4 py-3">
        <div
          className="flex overflow-hidden rounded-md border border-subtle"
          role="group"
          aria-label={t("research.overview.period")}
        >
          {DAY_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={days === option.value}
              className={cn(
                "px-2.5 py-1.5 text-12 transition-colors",
                days === option.value ? "bg-surface-1 text-primary" : "text-secondary hover:bg-surface-1"
              )}
              onClick={() => setDays(option.value)}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>
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
            const actionLabel = actionLabels[activity.action as keyof typeof actionLabels] ?? activity.action;
            const actorName = activity.actor?.display_name ?? t("research.activity_entities.system");
            const fullTime = new Date(activity.occurred_at).toLocaleString(currentLocale);
            const content = (
              <>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-13 font-medium text-primary">{actorName}</span>
                  <span className="text-12 text-secondary">{actionLabel}</span>
                  <span className="min-w-0 truncate text-13 text-primary">{activity.entity_name}</span>
                  <span className="rounded-sm bg-surface-1 px-1.5 py-0.5 text-11 text-tertiary">{entityLabel}</span>
                  {activity.project && (
                    <span className="min-w-0 truncate text-11 text-tertiary">{activity.project.name}</span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-11 text-tertiary">
                  <time dateTime={activity.occurred_at} title={fullTime}>
                    {calculateTimeAgo(activity.occurred_at)}
                  </time>
                  {activity.event_count > 1 && (
                    <span>{t("research.home_workbench.activity_grouped", { count: activity.event_count })}</span>
                  )}
                </div>
                {activity.changes.length > 0 && (
                  <dl className="mt-2 space-y-1 border-l border-subtle pl-3">
                    {activity.changes.slice(0, visibleChanges).map((change) => (
                      <div
                        key={`${activity.id}-${change.field ?? "change"}-${change.old_value ?? ""}-${change.new_value ?? ""}`}
                        className="flex flex-wrap gap-x-2 text-11"
                      >
                        <dt className="text-secondary">{change.field ?? entityLabel}</dt>
                        {change.old_value && <dd className="text-tertiary line-through">{change.old_value}</dd>}
                        {change.new_value && <dd className="min-w-0 break-words text-secondary">{change.new_value}</dd>}
                      </div>
                    ))}
                    {activity.changes.length > visibleChanges && (
                      <p className="text-11 text-tertiary">
                        {t("research.home_workbench.more_changes", { count: activity.changes.length - visibleChanges })}
                      </p>
                    )}
                  </dl>
                )}
              </>
            );

            return (
              <li key={activity.id}>
                {activity.url ? (
                  <Link href={activity.url} className="flex gap-3 px-4 py-3 transition-colors hover:bg-surface-1">
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
                  <article className="flex gap-3 px-4 py-3">
                    <span className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-1 text-11 text-tertiary">
                      {(activity.actor?.display_name ?? t("research.activity_entities.system"))
                        .slice(0, 1)
                        .toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">{content}</span>
                  </article>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canLoadMore && (
        <div ref={setLoadMoreElement} aria-hidden="true" data-testid="activity-auto-load-sentinel" className="h-0" />
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
