"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Skeleton } from "@plane/propel/skeleton";
import type { TProject, TProjectAnalyticsCount, TReportSummary, TResearchChain, TResearchIdentity } from "@plane/types";
// components
import { HomeSectionCard, type THomeDensity } from "@/components/home/home-section-card";
import { RecentActivityWidget } from "@/components/home/widgets/recents";
import {
  formatResearchDate,
  formatResearchReadAt,
  formatResearchTime,
} from "@/components/research/common/research-format";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { ResearchTodoEnvelopeList } from "@/components/research/common/research-todo-index";
import { ResearchTodoUrgency } from "@/components/research/common/research-todo-urgency";
// hooks
import { useProject } from "@/hooks/store/use-project";
import { useResearch } from "@/hooks/store/use-research";
// services
import { ResearchChainService } from "@/services/research/chain.service";
import { ResearchReportService } from "@/services/research/report.service";

const chainService = new ResearchChainService();
const reportService = new ResearchReportService();

type Props = {
  workspaceSlug: string;
};

type TLoadState = "loading" | "ready" | "empty" | "forbidden" | "error";
type TPeriod = "30" | "90" | "all";
type TReportPeriod = "WEEKLY" | "MONTHLY";
type TReportPeriodSummary = {
  workspaceSlug: string;
  identity: TResearchIdentity;
  summary: TReportSummary | null;
  state: TLoadState;
};

const REPORT_PERIODS = [
  { type: "WEEKLY", labelKey: "research.home_workbench.this_week" },
  { type: "MONTHLY", labelKey: "research.home_workbench.this_month" },
] as const;
const REPORT_BUCKETS = ["not_submitted", "needs_revision", "submitted", "accepted"] as const;

const PERIOD_OPTIONS = [
  { value: "30" as const, labelKey: "research.overview.period_30" },
  { value: "90" as const, labelKey: "research.overview.period_90" },
  { value: "all" as const, labelKey: "research.overview.period_all" },
];

const DENSITY_OPTIONS = [
  { value: "compact" as const, labelKey: "research.home_workbench.density_compact" },
  { value: "detailed" as const, labelKey: "research.home_workbench.density_detailed" },
];

const DENSITY_STORAGE_KEY = "plane.home.workbench.density";

/** 读取持久化的首页密度偏好；环境不可用或值非法时回退紧凑模式。 */
function readStoredDensity(): THomeDensity {
  if (typeof window === "undefined") return "compact";
  return window.localStorage.getItem(DENSITY_STORAGE_KEY) === "detailed" ? "detailed" : "compact";
}
/** 渲染行动优先的 Bento 工作台首页：待办与科研在首行，辅助模块在次行。 */
export const WorkspaceHomeWorkbench = observer(function WorkspaceHomeWorkbench({ workspaceSlug }: Props) {
  const { t, currentLocale } = useTranslation();
  const research = useResearch();
  const { fetchProjects, fetchProjectAnalyticsCount } = useProject();
  const [period, setPeriod] = useState<TPeriod>("30");
  const [density, setDensity] = useState<THomeDensity>(readStoredDensity);
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [chains, setChains] = useState<TResearchChain[]>([]);
  const [chainState, setChainState] = useState<TLoadState>("loading");
  const [administrativeProjects, setAdministrativeProjects] = useState<TProject[]>([]);
  const [administrativeStats, setAdministrativeStats] = useState<Record<string, TProjectAnalyticsCount>>({});
  const [administrativeStatsLoading, setAdministrativeStatsLoading] = useState(false);
  const [administrativeState, setAdministrativeState] = useState<TLoadState>("loading");
  const [reportSummaries, setReportSummaries] = useState<Partial<Record<TReportPeriod, TReportPeriodSummary>>>({});
  const researchVersion = useRef(0);
  const administrativeVersion = useRef(0);
  const reportVersion = useRef(0);

  const canSeeResearch = Boolean(
    research.identity?.module_enabled &&
    research.identity?.workspace_enabled &&
    research.identity?.sections?.research_chain &&
    research.canSee("research_chain")
  );
  const reportIdentity = research.identity;
  const canSeeSummary = Boolean(
    research.identityWorkspaceSlug === workspaceSlug &&
    research.identity?.module_enabled &&
    research.identity?.workspace_enabled &&
    research.identity?.sections?.reports &&
    research.canSee("summary")
  );

  useEffect(() => {
    if (research.identityWorkspaceSlug !== workspaceSlug || !research.identity) {
      void research.fetchIdentity(workspaceSlug).catch(() => undefined);
    }
  }, [research, workspaceSlug]);

  const loadChains = useCallback(async () => {
    const version = ++researchVersion.current;
    setChainState("loading");
    try {
      const result = await chainService.getChains(workspaceSlug);
      if (researchVersion.current !== version) return;
      setChains(result);
      setChainState(result.length ? "ready" : "empty");
    } catch (error) {
      if (researchVersion.current !== version) return;
      setChains([]);
      setChainState(
        (error as { error_code?: string })?.error_code === "research_permission_denied" ? "forbidden" : "error"
      );
    }
  }, [workspaceSlug]);

  const loadAdministrativeProjects = useCallback(async () => {
    const version = ++administrativeVersion.current;
    setAdministrativeState("loading");
    setAdministrativeStats({});
    setAdministrativeStatsLoading(false);
    try {
      const result = await fetchProjects(workspaceSlug);
      if (administrativeVersion.current !== version) return;
      const administrative = result.filter((project) => !project.is_research_project && !project.archived_at);
      setAdministrativeProjects(administrative);
      setAdministrativeState(administrative.length ? "ready" : "empty");
      if (!administrative.length) return;
      setAdministrativeStatsLoading(true);
      try {
        const stats = await fetchProjectAnalyticsCount(workspaceSlug, {
          project_ids: administrative.map((project) => project.id).join(","),
          fields: "open_issues,done_issues,last_activity_at",
        });
        if (administrativeVersion.current !== version) return;
        setAdministrativeStats(Object.fromEntries(stats.map((entry) => [entry.id, entry])));
      } catch {
        // 项目列表仍可使用，统计失败时显示未知而非零值。
        if (administrativeVersion.current !== version) return;
        setAdministrativeStats({});
      } finally {
        if (administrativeVersion.current === version) setAdministrativeStatsLoading(false);
      }
    } catch {
      if (administrativeVersion.current !== version) return;
      setAdministrativeProjects([]);
      setAdministrativeState("error");
    }
  }, [fetchProjects, fetchProjectAnalyticsCount, workspaceSlug]);

  const loadReportSummary = useCallback(async () => {
    const version = ++reportVersion.current;
    setReportSummaries({});
    if (!canSeeSummary || !reportIdentity) {
      return;
    }
    await Promise.all(
      REPORT_PERIODS.map(async ({ type }) => {
        try {
          const summary = await reportService.getSummary(workspaceSlug, { report_type: type });
          if (reportVersion.current !== version) return;
          setReportSummaries((current) => ({
            ...current,
            [type]: { workspaceSlug, identity: reportIdentity, summary, state: "ready" },
          }));
        } catch (error) {
          if (reportVersion.current !== version) return;
          const state =
            (error as { error_code?: string })?.error_code === "research_permission_denied" ? "forbidden" : "error";
          setReportSummaries((current) => ({
            ...current,
            [type]: { workspaceSlug, identity: reportIdentity, summary: null, state },
          }));
        }
      })
    );
  }, [canSeeSummary, reportIdentity, workspaceSlug]);

  useEffect(() => {
    if (canSeeResearch) void loadChains();
    else setChainState("forbidden");
  }, [canSeeResearch, loadChains, refreshToken]);

  useEffect(() => {
    void loadAdministrativeProjects();
    return () => {
      administrativeVersion.current += 1;
    };
  }, [loadAdministrativeProjects, refreshToken]);

  useEffect(() => {
    void loadReportSummary();
    return () => {
      reportVersion.current += 1;
    };
  }, [loadReportSummary, refreshToken]);

  const periodDays = period === "all" ? null : Number(period);
  const periodStart = periodDays ? Date.now() - periodDays * 86400000 : 0;
  const visibleChains = chains.filter((chain) => new Date(chain.updated_at).getTime() >= periodStart);
  const activeChains = visibleChains.filter((chain) => chain.status === "ACTIVE");
  const openTaskCount = visibleChains.reduce((total, chain) => total + (chain.open_task_count ?? 0), 0);
  const nextDueAt = visibleChains
    .map((chain) => chain.next_due_at)
    .filter((value): value is string => Boolean(value))
    .reduce<string | null>((earliest, value) => (earliest === null || value < earliest ? value : earliest), null);

  const refresh = () => {
    setRefreshToken((value) => value + 1);
    setRefreshedAt(new Date());
  };
  /** 将密度偏好写入本地存储，保证下次进入首页时保持一致。 */
  useEffect(() => {
    window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
  }, [density]);

  const summaryHref = "/public/research/chains/?view=reports";
  // oxlint-disable-next-line unicorn/no-array-sort -- 当前 TypeScript lib 不支持 toSorted，排序副本避免修改原列表。
  const sortedAdministrativeProjects = [...administrativeProjects].sort((left, right) => {
    const leftTime = administrativeStats[left.id]?.last_activity_at;
    const rightTime = administrativeStats[right.id]?.last_activity_at;
    return (rightTime ? Date.parse(rightTime) || 0 : 0) - (leftTime ? Date.parse(leftTime) || 0 : 0);
  });
  const todosHref = `/${workspaceSlug}/research/todos`;
  const cardLinkClassName = "text-12 text-accent-primary hover:underline";

  return (
    <div
      className={`flex min-w-0 flex-col gap-5 ${
        density === "compact" ? "min-h-full xl:h-full xl:min-h-0 xl:flex-1 xl:overflow-hidden" : "min-h-full"
      }`}
    >
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-22 font-semibold text-primary">{t("research.home_workbench.title")}</h1>
          <p className="mt-1 text-12 text-tertiary">
            {refreshedAt
              ? `${t("research.overview.refreshed_at")} ${formatResearchTime(refreshedAt, currentLocale)}`
              : t("research.home_workbench.description")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex overflow-hidden rounded-md border border-subtle"
            role="group"
            aria-label={t("research.overview.period")}
          >
            {PERIOD_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={period === option.value}
                className={`px-2.5 py-1.5 text-12 transition-colors ${
                  period === option.value ? "bg-surface-2 text-primary" : "text-secondary hover:bg-surface-2"
                }`}
                onClick={() => setPeriod(option.value)}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
          <div
            className="flex overflow-hidden rounded-md border border-subtle"
            role="group"
            aria-label={t("research.home_workbench.density_label")}
          >
            {DENSITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={density === option.value}
                className={`px-2.5 py-1.5 text-12 transition-colors ${
                  density === option.value ? "bg-surface-2 text-primary" : "text-secondary hover:bg-surface-2"
                }`}
                onClick={() => setDensity(option.value)}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={refresh}>
            {t("research.common.refresh")}
          </Button>
        </div>
      </header>

      <div
        className={`grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-12 ${
          density === "compact" ? "xl:min-h-0 xl:flex-1 xl:grid-rows-[minmax(0,3fr)_minmax(0,2fr)]" : ""
        }`}
        data-testid="workspace-home-columns"
      >
        <HomeSectionCard
          className="xl:col-span-5"
          size="primary"
          density={density}
          title={t("research.todo.title")}
          hint={t("research.todo.description_v2")}
          action={
            <Link href={todosHref} className={cardLinkClassName}>
              {t("research.home_workbench.view_todos")}
            </Link>
          }
        >
          <ResearchTodoEnvelopeList
            key={`todo-${refreshToken}`}
            workspaceSlug={workspaceSlug}
            periodDays={periodDays}
            embedded
          />
        </HomeSectionCard>

        <HomeSectionCard
          className="xl:col-span-7"
          size="primary"
          density={density}
          title={t("research.home_workbench.research_overview")}
          hint={t("research.home_workbench.research_hint")}
          action={
            canSeeResearch ? (
              <Link href={`/${workspaceSlug}/research/chains`} className={cardLinkClassName}>
                {t("research.home_workbench.all_research")}
              </Link>
            ) : undefined
          }
          footer={
            chainState === "ready"
              ? t("research.home_workbench.total_chains", { count: visibleChains.length })
              : undefined
          }
        >
          {chainState === "loading" && (
            <div className="space-y-2 p-4" role="status" aria-busy="true">
              {[0, 1, 2].map((row) => (
                <Skeleton.Item key={row} height="44px" width="100%" />
              ))}
            </div>
          )}
          {chainState === "forbidden" && (
            <p className="p-4 text-12 text-secondary">{t("research.home_summary.forbidden")}</p>
          )}
          {chainState === "error" && (
            <p className="p-4 text-12 text-secondary" role="alert">
              {t("research.portal.load_failed")}
            </p>
          )}
          {chainState === "empty" && (
            <p className="p-4 text-12 text-secondary">{t("research.home_workbench.research_empty")}</p>
          )}
          {chainState === "ready" && (
            <>
              <div className="grid shrink-0 grid-cols-3 divide-x divide-subtle border-b border-subtle">
                <div className="px-4 py-3">
                  <p className="text-11 text-tertiary">{t("research.home_summary.active_chains")}</p>
                  <p className="mt-1 text-20 font-semibold text-primary tabular-nums">{activeChains.length}</p>
                </div>
                <div className="px-4 py-3">
                  <p className="text-11 text-tertiary">{t("research.home_workbench.open_tasks")}</p>
                  <p className="mt-1 text-20 font-semibold text-primary tabular-nums">{openTaskCount}</p>
                </div>
                <div className="min-w-0 px-4 py-3">
                  <p className="text-11 text-tertiary">{t("research.chains.next_due_at")}</p>
                  <p className="mt-1 truncate text-13 font-medium text-primary">
                    {nextDueAt ? formatResearchDate(nextDueAt, currentLocale) : "-"}
                  </p>
                </div>
              </div>
              <ul className="divide-y divide-subtle" role="list">
                {visibleChains.map((chain) => (
                  <li key={chain.id} className="px-4 py-3 hover:bg-surface-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link
                        href={`/${workspaceSlug}/research/chains/${chain.id}`}
                        className="min-w-0 truncate text-13 font-medium text-primary hover:text-accent-primary"
                      >
                        {chain.project_name ?? chain.project}
                      </Link>
                      <ResearchStatusBadge status={chain.status} size="sm">
                        {t(`research.chains.chain_status.${chain.status.toLowerCase()}`)}
                      </ResearchStatusBadge>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-11 text-tertiary">
                      <span className="truncate">
                        {t("research.chains.current_node")}：{chain.current_node?.title ?? "-"}
                      </span>
                      <span>{t("research.chains.open_task_count", { count: chain.open_task_count ?? 0 })}</span>
                      {chain.next_due_at && <ResearchTodoUrgency dueAt={chain.next_due_at} />}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </HomeSectionCard>

        <HomeSectionCard
          className="xl:col-span-4"
          density={density}
          title={t("research.home_workbench.administrative_overview")}
          hint={t("research.home_workbench.administrative_hint")}
          action={
            <Link href={`/${workspaceSlug}/projects`} className={cardLinkClassName}>
              {t("research.home_workbench.all_administrative")}
            </Link>
          }
          footer={
            administrativeState === "ready"
              ? t("research.home_workbench.total_administrative", { count: administrativeProjects.length })
              : undefined
          }
        >
          {administrativeState === "loading" && (
            <div className="space-y-2 p-4" role="status" aria-busy="true">
              {[0, 1].map((row) => (
                <Skeleton.Item key={row} height="40px" width="100%" />
              ))}
            </div>
          )}
          {administrativeState === "error" && (
            <p className="p-4 text-12 text-secondary" role="alert">
              {t("research.home_workbench.administrative_error")}
            </p>
          )}
          {administrativeState === "empty" && (
            <p className="p-4 text-12 text-secondary">{t("research.home_workbench.administrative_empty")}</p>
          )}
          {administrativeState === "ready" && (
            <ul className="divide-y divide-subtle" role="list">
              {sortedAdministrativeProjects.map((project) => (
                <li key={project.id} className="min-w-0 px-4 py-3 hover:bg-surface-1">
                  <Link
                    href={`/${workspaceSlug}/projects/${project.id}/issues`}
                    className="block min-w-0 text-13 font-medium break-words text-primary hover:text-accent-primary"
                  >
                    {project.name}
                  </Link>
                  <p className="mt-1 text-11 text-tertiary tabular-nums">
                    {t("research.home_workbench.administrative_updated_at", {
                      value:
                        formatResearchReadAt(administrativeStats[project.id]?.last_activity_at, currentLocale) || "-",
                    })}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-11 text-secondary tabular-nums">
                    {typeof administrativeStats[project.id]?.open_issues === "number" &&
                    typeof administrativeStats[project.id]?.done_issues === "number" ? (
                      <>
                        <span>
                          {t("research.home_workbench.administrative_open_issues", {
                            count: administrativeStats[project.id].open_issues,
                          })}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {t("research.home_workbench.administrative_done_issues", {
                            count: administrativeStats[project.id].done_issues,
                          })}
                        </span>
                      </>
                    ) : (
                      <span>
                        {t(
                          administrativeStatsLoading
                            ? "loading"
                            : "research.home_workbench.administrative_stats_unavailable"
                        )}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </HomeSectionCard>

        <HomeSectionCard
          className="xl:col-span-4"
          density={density}
          title={t("research.home_workbench.recent_activity")}
        >
          <RecentActivityWidget
            workspaceSlug={workspaceSlug}
            showFilterSelect={false}
            embedded
            scope="administrative"
            refreshToken={refreshToken}
          />
        </HomeSectionCard>

        <HomeSectionCard
          className="xl:col-span-4"
          density={density}
          title={t("research.home_workbench.report_summary")}
          action={
            canSeeSummary ? (
              <Link href={summaryHref} className={cardLinkClassName}>
                {t("research.home_workbench.view_summary")}
              </Link>
            ) : undefined
          }
        >
          {!canSeeSummary ? (
            <p className="p-4 text-12 text-secondary">{t("research.home_summary.forbidden")}</p>
          ) : (
            <div className="divide-y divide-subtle">
              {REPORT_PERIODS.map(({ type, labelKey }) => {
                const entry = reportSummaries[type];
                const isCurrent = entry?.workspaceSlug === workspaceSlug && entry.identity === reportIdentity;
                const summary = isCurrent ? entry.summary : null;
                const state = isCurrent ? entry.state : "loading";
                return (
                  <div key={type} className="min-w-0 px-4 py-3" role="group" aria-label={t(labelKey)}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                      <h3 className="text-13 font-medium text-primary">{t(labelKey)}</h3>
                      {summary && <span className="text-11 text-tertiary">{summary.period_key}</span>}
                    </div>
                    {summary && (
                      <p className="mt-0.5 text-11 text-tertiary">
                        {summary.period_start} ~ {summary.period_end}
                      </p>
                    )}
                    {state === "loading" && (
                      <div className="mt-2" role="status" aria-busy="true">
                        <Skeleton.Item height="48px" width="100%" />
                      </div>
                    )}
                    {state === "error" && (
                      <p className="mt-2 text-12 text-secondary" role="alert">
                        {t("research.home_workbench.report_error")}
                      </p>
                    )}
                    {state === "forbidden" && (
                      <p className="mt-2 text-12 text-secondary">{t("research.home_summary.forbidden")}</p>
                    )}
                    {summary && state === "ready" && (
                      <div className="mt-2 grid min-w-0 grid-cols-2 gap-y-2 sm:grid-cols-4">
                        {REPORT_BUCKETS.map((bucket) => (
                          <Link
                            key={bucket}
                            href={summaryHref}
                            className="min-w-0 rounded-sm py-1 pr-2 transition-colors hover:bg-surface-1"
                          >
                            <p className="text-11 text-tertiary">{t(`research.summary.${bucket}`)}</p>
                            <p className="mt-1 text-20 font-semibold break-all text-primary tabular-nums">
                              {summary.counts[bucket]}
                            </p>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </HomeSectionCard>
      </div>
    </div>
  );
});
