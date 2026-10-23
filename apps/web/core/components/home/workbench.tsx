"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Skeleton } from "@plane/propel/skeleton";
import type {
  TProject,
  TProjectAnalyticsCount,
  TReportSummary,
  TResearchChain,
  TResearchIdentity,
  TWorkbenchWidgetKey,
} from "@plane/types";
// components
import { HomeSectionCard } from "@/components/home/home-section-card";
import { ReportPeriodSelector, type TCustomReportPeriod } from "@/components/home/report-period-selector";
import { HomeActivityWidget } from "@/components/home/widgets/activity";
import {
  formatResearchDate,
  formatResearchReadAt,
  formatResearchTime,
} from "@/components/research/common/research-format";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { chainOwnerLabel, visibleResearchChains } from "@/components/research/common/research-overview-rows";
import { WorkspaceTodos } from "@/components/home/workspace-todos";
import { WorkbenchPreferencesPanel } from "@/components/home/workbench-preferences-panel";
import { useHomeWorkbenchPreferences } from "@/hooks/home/use-home-workbench-preferences";
import { useWorkspaceContext } from "@/hooks/use-workspace-context";
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
type TReportPresetOption = (typeof REPORT_PERIOD_PRESETS)[number];
type TReportPeriodSelection =
  | { kind: "preset"; preset: TReportPresetOption }
  | ({ kind: "custom" } & TCustomReportPeriod);
type TReportSummaryState = {
  workspaceSlug: string;
  identity: TResearchIdentity;
  selection: TReportPeriodSelection;
  summary: TReportSummary | null;
  state: TLoadState;
};

const REPORT_PERIOD_PRESETS = [
  {
    value: "CURRENT_WEEK",
    reportType: "WEEKLY",
    periodOffset: 0,
    labelKey: "research.home_workbench.this_week",
  },
  {
    value: "LAST_WEEK",
    reportType: "WEEKLY",
    periodOffset: -1,
    labelKey: "research.home_workbench.last_week",
  },
  {
    value: "CURRENT_MONTH",
    reportType: "MONTHLY",
    periodOffset: 0,
    labelKey: "research.home_workbench.this_month",
  },
  {
    value: "LAST_MONTH",
    reportType: "MONTHLY",
    periodOffset: -1,
    labelKey: "research.home_workbench.last_month",
  },
] as const;
const DEFAULT_REPORT_PERIOD_PRESET = REPORT_PERIOD_PRESETS[0];
const DEFAULT_REPORT_PERIOD_SELECTION: TReportPeriodSelection = {
  kind: "preset",
  preset: DEFAULT_REPORT_PERIOD_PRESET,
};

const REPORT_BUCKETS = ["not_submitted", "needs_revision", "submitted", "accepted"] as const;

const PERIOD_OPTIONS = [
  { value: "30" as const, labelKey: "research.overview.period_30" },
  { value: "90" as const, labelKey: "research.overview.period_90" },
  { value: "all" as const, labelKey: "research.overview.period_all" },
];

/** 渲染行动优先的 Bento 工作台首页：待办与科研在首行，辅助模块在次行。 */
export const WorkspaceHomeWorkbench = observer(function WorkspaceHomeWorkbench({ workspaceSlug }: Props) {
  const { t, currentLocale } = useTranslation();
  const research = useResearch();
  const { context } = useWorkspaceContext();
  const { fetchProjects, fetchProjectAnalyticsCount } = useProject();
  const [period, setPeriod] = useState<TPeriod>("30");
  const [isEditingLayout, setIsEditingLayout] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [chains, setChains] = useState<TResearchChain[]>([]);
  const [chainState, setChainState] = useState<TLoadState>("loading");
  const [administrativeProjects, setAdministrativeProjects] = useState<TProject[]>([]);
  const [administrativeStats, setAdministrativeStats] = useState<Record<string, TProjectAnalyticsCount>>({});
  const [administrativeStatsLoading, setAdministrativeStatsLoading] = useState(false);
  const [administrativeState, setAdministrativeState] = useState<TLoadState>("loading");
  const [selectedReportPeriod, setSelectedReportPeriod] = useState<TReportPeriodSelection>(
    DEFAULT_REPORT_PERIOD_SELECTION
  );
  const [reportSummaryState, setReportSummaryState] = useState<TReportSummaryState | null>(null);
  const researchVersion = useRef(0);
  const administrativeVersion = useRef(0);
  const reportVersion = useRef(0);

  const canSeeResearch = Boolean(
    context?.module_enabled &&
    context?.workspace_enabled &&
    context?.sections?.research_chain &&
    (research.canSee("research_chain") || research.isResearchAdmin)
  );
  const reportIdentity = research.identity;
  const canSeeSummary = Boolean(
    research.identityWorkspaceSlug === workspaceSlug &&
    context?.module_enabled &&
    context?.workspace_enabled &&
    research.identity?.sections?.reports &&
    (research.canSee("summary") || research.isResearchAdmin)
  );

  const availableWidgetKeys = useMemo<TWorkbenchWidgetKey[]>(
    () => [
      "my_todos",
      ...(canSeeResearch ? (["research_projects"] as const) : []),
      "administrative_projects",
      "recent_activity",
      ...(canSeeSummary ? (["report_summary"] as const) : []),
    ],
    [canSeeResearch, canSeeSummary]
  );
  const {
    loading: preferencesLoading,
    error: preferencesError,
    syncError,
    saving,
    widgets,
    enabledWidgets,
    density,
    toggleWidget,
    setWidgetSize,
    moveWidget,
    resetWidgets,
    setDensity,
  } = useHomeWorkbenchPreferences(workspaceSlug, availableWidgetKeys);
  const widgetByKey = new Map(enabledWidgets.map((widget) => [widget.key, widget]));
  const isWidgetVisible = (key: TWorkbenchWidgetKey) => Boolean(widgetByKey.get(key)?.is_enabled);
  const showResearchWidget = canSeeResearch && isWidgetVisible("research_projects");
  const showAdministrativeWidget = isWidgetVisible("administrative_projects");
  const showActivityWidget = isWidgetVisible("recent_activity");
  const showReportWidget = canSeeSummary && isWidgetVisible("report_summary");
  const widgetClassName = (key: TWorkbenchWidgetKey) => {
    const orderIndex = enabledWidgets.findIndex((widget) => widget.key === key);
    const orderClass = ["order-1", "order-2", "order-3", "order-4", "order-5"][orderIndex] ?? "order-last";
    if (enabledWidgets.length === 1) return `${orderClass} xl:col-span-12 xl:min-h-[60vh]`;
    const size = widgetByKey.get(key)?.size ?? "medium";
    const spanClass = {
      small: "xl:col-span-4",
      medium: "xl:col-span-6",
      large: "xl:col-span-8",
      full: "xl:col-span-12",
    }[size];
    return `${orderClass} ${spanClass}`;
  };

  useEffect(() => {
    if (research.identityWorkspaceSlug !== workspaceSlug || !research.identity) {
      void research.fetchIdentity(workspaceSlug).catch(() => undefined);
    }
  }, [research, workspaceSlug]);

  const loadChains = useCallback(async () => {
    const version = ++researchVersion.current;
    setChainState("loading");
    try {
      const result = visibleResearchChains(await chainService.getChains(workspaceSlug));
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
      const result = await fetchProjects(workspaceSlug, "administrative");
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
    setReportSummaryState(null);
    if (!canSeeSummary || !reportIdentity) {
      return;
    }
    try {
      const summary = await reportService.getSummary(workspaceSlug, {
        report_type:
          selectedReportPeriod.kind === "preset"
            ? selectedReportPeriod.preset.reportType
            : selectedReportPeriod.reportType,
        ...(selectedReportPeriod.kind === "preset"
          ? { period_offset: selectedReportPeriod.preset.periodOffset }
          : { period_key: selectedReportPeriod.periodKey }),
      });
      if (reportVersion.current !== version) return;
      setReportSummaryState({
        workspaceSlug,
        identity: reportIdentity,
        selection: selectedReportPeriod,
        summary,
        state: "ready",
      });
    } catch (error) {
      if (reportVersion.current !== version) return;
      const state =
        (error as { error_code?: string })?.error_code === "research_permission_denied" ? "forbidden" : "error";
      setReportSummaryState({
        workspaceSlug,
        identity: reportIdentity,
        selection: selectedReportPeriod,
        summary: null,
        state,
      });
    }
  }, [canSeeSummary, reportIdentity, selectedReportPeriod, workspaceSlug]);

  useEffect(() => {
    if (showResearchWidget) void loadChains();
    else {
      setChains([]);
      setChainState("forbidden");
    }
    return () => {
      researchVersion.current += 1;
    };
  }, [loadChains, refreshToken, showResearchWidget]);

  useEffect(() => {
    if (!showAdministrativeWidget) {
      setAdministrativeProjects([]);
      setAdministrativeState("empty");
      return () => {
        administrativeVersion.current += 1;
      };
    }
    void loadAdministrativeProjects();
    return () => {
      administrativeVersion.current += 1;
    };
  }, [loadAdministrativeProjects, refreshToken, showAdministrativeWidget]);

  useEffect(() => {
    if (!showReportWidget) {
      setReportSummaryState(null);
      return () => {
        reportVersion.current += 1;
      };
    }
    void loadReportSummary();
    return () => {
      reportVersion.current += 1;
    };
  }, [loadReportSummary, refreshToken, showReportWidget]);

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
  const currentReportSummaryState =
    reportSummaryState?.workspaceSlug === workspaceSlug &&
    reportSummaryState.identity === reportIdentity &&
    reportSummaryState.selection === selectedReportPeriod
      ? reportSummaryState
      : null;
  const reportState = currentReportSummaryState?.state ?? "loading";
  const reportSummary = currentReportSummaryState?.summary ?? null;
  const reportSummaryHref = reportSummary
    ? `/${workspaceSlug}/research/chains/?view=reports&report_type=${
        selectedReportPeriod.kind === "preset"
          ? selectedReportPeriod.preset.reportType
          : selectedReportPeriod.reportType
      }&period_key=${encodeURIComponent(reportSummary.period_key)}`
    : `/${workspaceSlug}/research/chains/?view=reports`;
  const reportPeriodLabel =
    selectedReportPeriod.kind === "preset"
      ? t(selectedReportPeriod.preset.labelKey)
      : t("research.home_workbench.custom_period");
  const customReportPeriod =
    selectedReportPeriod.kind === "custom"
      ? { reportType: selectedReportPeriod.reportType, periodKey: selectedReportPeriod.periodKey }
      : null;
  // oxlint-disable-next-line unicorn/no-array-sort -- 当前 TypeScript lib 不支持 toSorted，排序副本避免修改原列表。
  const sortedAdministrativeProjects = [...administrativeProjects].sort((left, right) => {
    const leftTime = administrativeStats[left.id]?.last_activity_at;
    const rightTime = administrativeStats[right.id]?.last_activity_at;
    return (rightTime ? Date.parse(rightTime) || 0 : 0) - (leftTime ? Date.parse(leftTime) || 0 : 0);
  });
  const todosHref = `/${workspaceSlug}/todos`;
  const cardLinkClassName = "text-12 text-accent-primary hover:underline";

  return (
    <div className="flex min-h-full min-w-0 flex-col gap-5">
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
          {showResearchWidget && (
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
          )}
          <Button
            variant="secondary"
            size="sm"
            aria-pressed={isEditingLayout}
            onClick={() => setIsEditingLayout((value) => !value)}
          >
            {isEditingLayout
              ? t("research.home_workbench.finish_customization")
              : t("research.home_workbench.customize")}
          </Button>
          <Button variant="secondary" size="sm" onClick={refresh}>
            {t("research.common.refresh")}
          </Button>
        </div>
      </header>

      {isEditingLayout && (
        <WorkbenchPreferencesPanel
          widgets={widgets}
          density={density}
          saving={saving}
          syncError={syncError}
          onToggle={(key, enabled) => void toggleWidget(key, enabled)}
          onMove={(key, direction) => void moveWidget(key, direction)}
          onSizeChange={(key, size) => void setWidgetSize(key, size)}
          onDensityChange={(nextDensity) => void setDensity(nextDensity)}
          onReset={() => void resetWidgets()}
        />
      )}
      {preferencesError && (
        <p className="rounded-xl border border-subtle bg-surface-2 px-4 py-3 text-12 text-secondary" role="alert">
          {t("research.home_workbench.preferences_load_fallback")}
        </p>
      )}
      {preferencesLoading ? (
        <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-12" data-testid="workspace-home-columns">
          <div className="xl:col-span-6">
            <Skeleton.Item height="280px" width="100%" />
          </div>
          <div className="xl:col-span-6">
            <Skeleton.Item height="280px" width="100%" />
          </div>
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-12" data-testid="workspace-home-columns">
          {isWidgetVisible("my_todos") && (
            <HomeSectionCard
              className={widgetClassName("my_todos")}
              density={density}
              title={t("research.home_workbench.widget_my_todos")}
              hint={t("research.home_workbench.widget_my_todos_hint")}
              action={
                <Link href={todosHref} className={cardLinkClassName}>
                  {t("research.home_workbench.view_todos")}
                </Link>
              }
            >
              <WorkspaceTodos key={`todo-${refreshToken}`} workspaceSlug={workspaceSlug} embedded />
            </HomeSectionCard>
          )}

          {showResearchWidget && (
            <HomeSectionCard
              className={widgetClassName("research_projects")}
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
                          <span className="min-w-0 [overflow-wrap:anywhere] break-words">
                            {t("research.chains.owner")}：
                            {chainOwnerLabel(research.identity, chain) || t("research.projects.owner_unset")}
                          </span>
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
          )}

          {showAdministrativeWidget && (
            <HomeSectionCard
              className={widgetClassName("administrative_projects")}
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
                            formatResearchReadAt(administrativeStats[project.id]?.last_activity_at, currentLocale) ||
                            "-",
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
          )}

          {showActivityWidget && (
            <HomeSectionCard
              className={widgetClassName("recent_activity")}
              density={density}
              title={t("research.home_workbench.recent_activity")}
              hint={t("research.home_workbench.widget_recent_activity_hint")}
            >
              <HomeActivityWidget workspaceSlug={workspaceSlug} density={density} refreshToken={refreshToken} />
            </HomeSectionCard>
          )}

          {showReportWidget && (
            <HomeSectionCard
              className={widgetClassName("report_summary")}
              density={density}
              title={t("research.home_workbench.report_summary")}
              action={
                canSeeSummary ? (
                  <Link href={reportSummaryHref} className={cardLinkClassName}>
                    {t("research.home_workbench.view_summary")}
                  </Link>
                ) : undefined
              }
            >
              {!canSeeSummary ? (
                <p className="p-4 text-12 text-secondary">{t("research.home_summary.forbidden")}</p>
              ) : (
                <>
                  <div className="px-4 py-3">
                    <div className="flex max-w-full flex-wrap items-center gap-1.5">
                      <div
                        className="inline-flex max-w-full flex-wrap overflow-hidden rounded-md border border-subtle"
                        role="group"
                        aria-label={t("research.overview.period")}
                      >
                        {REPORT_PERIOD_PRESETS.map((preset) => (
                          <button
                            key={preset.value}
                            type="button"
                            aria-pressed={
                              selectedReportPeriod.kind === "preset" &&
                              selectedReportPeriod.preset.value === preset.value
                            }
                            className={`min-w-0 px-2.5 py-1.5 text-12 transition-colors ${
                              selectedReportPeriod.kind === "preset" &&
                              selectedReportPeriod.preset.value === preset.value
                                ? "bg-surface-1 text-primary"
                                : "text-secondary hover:bg-surface-1"
                            }`}
                            onClick={() => setSelectedReportPeriod({ kind: "preset", preset })}
                          >
                            {t(preset.labelKey)}
                          </button>
                        ))}
                      </div>
                      <ReportPeriodSelector
                        customPeriod={customReportPeriod}
                        reportTimezone={reportIdentity?.workspace?.report_timezone}
                        onSelect={(selection) => setSelectedReportPeriod({ kind: "custom", ...selection })}
                      />
                    </div>
                  </div>
                  <div className="min-w-0 border-t border-subtle px-4 py-3" role="group" aria-label={reportPeriodLabel}>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                      <h3 className="text-13 font-medium text-primary">{reportPeriodLabel}</h3>
                      {reportSummary && <span className="text-11 text-tertiary">{reportSummary.period_key}</span>}
                    </div>
                    {reportSummary && (
                      <p className="mt-0.5 text-11 text-tertiary">
                        {reportSummary.period_start} ~ {reportSummary.period_end}
                      </p>
                    )}
                    {reportState === "loading" && (
                      <div className="mt-2" role="status" aria-busy="true">
                        <Skeleton.Item height="48px" width="100%" />
                      </div>
                    )}
                    {reportState === "error" && (
                      <p className="mt-2 text-12 text-secondary" role="alert">
                        {t("research.home_workbench.report_error")}
                      </p>
                    )}
                    {reportState === "forbidden" && (
                      <p className="mt-2 text-12 text-secondary">{t("research.home_summary.forbidden")}</p>
                    )}
                    {reportSummary && reportState === "ready" && (
                      <div className="mt-2 grid min-w-0 grid-cols-2 gap-y-2 sm:grid-cols-4">
                        {REPORT_BUCKETS.map((bucket) => (
                          <Link
                            key={bucket}
                            href={reportSummaryHref}
                            className="min-w-0 rounded-sm py-1 pr-2 transition-colors hover:bg-surface-1"
                          >
                            <p className="text-11 text-tertiary">{t(`research.summary.${bucket}`)}</p>
                            <p className="mt-1 text-20 font-semibold break-all text-primary tabular-nums">
                              {reportSummary.counts[bucket]}
                            </p>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </HomeSectionCard>
          )}
          {enabledWidgets.length === 0 && (
            <section className="rounded-xl border border-subtle bg-surface-2 px-4 py-12 text-center xl:col-span-12">
              <h2 className="text-14 font-semibold text-primary">{t("research.home_workbench.minimal_empty_title")}</h2>
              <p className="mx-auto mt-1 max-w-md text-12 text-tertiary">
                {t("research.home_workbench.minimal_empty_hint")}
              </p>
              <Button variant="secondary" size="sm" className="mt-4" onClick={() => setIsEditingLayout(true)}>
                {t("research.home_workbench.add_widget")}
              </Button>
            </section>
          )}
        </div>
      )}
    </div>
  );
});
