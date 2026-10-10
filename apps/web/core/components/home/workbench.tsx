"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Skeleton } from "@plane/propel/skeleton";
import type { TProject, TReportSummary, TResearchChain } from "@plane/types";
// components
import { RecentActivityWidget } from "@/components/home/widgets/recents";
import { formatResearchDate, formatResearchTime } from "@/components/research/common/research-format";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { ResearchTodoEnvelopeList } from "@/components/research/common/research-todo-index";
import { ResearchTodoUrgency } from "@/components/research/common/research-todo-urgency";
// hooks
import { useProject } from "@/hooks/store/use-project";
import { useResearch } from "@/hooks/store/use-research";
// services
import { ResearchChainService } from "@/services/research/chain.service";

const chainService = new ResearchChainService();

type Props = {
  workspaceSlug: string;
};

type TLoadState = "loading" | "ready" | "empty" | "forbidden" | "error";
type TPeriod = "30" | "90" | "all";

const PERIOD_OPTIONS = [
  { value: "30" as const, labelKey: "research.overview.period_30" },
  { value: "90" as const, labelKey: "research.overview.period_90" },
  { value: "all" as const, labelKey: "research.overview.period_all" },
];

/** Render the quiet two-column research and administrative workspace home. */
export const WorkspaceHomeWorkbench = observer(function WorkspaceHomeWorkbench({ workspaceSlug }: Props) {
  const { t, currentLocale } = useTranslation();
  const research = useResearch();
  const { fetchProjects } = useProject();
  const [period, setPeriod] = useState<TPeriod>("30");
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [chains, setChains] = useState<TResearchChain[]>([]);
  const [chainState, setChainState] = useState<TLoadState>("loading");
  const [administrativeProjects, setAdministrativeProjects] = useState<TProject[]>([]);
  const [administrativeState, setAdministrativeState] = useState<TLoadState>("loading");
  const [reportSummary, setReportSummary] = useState<TReportSummary | null>(null);
  const [reportState, setReportState] = useState<TLoadState>("loading");
  const researchVersion = useRef(0);
  const administrativeVersion = useRef(0);
  const reportVersion = useRef(0);

  const canSeeResearch = Boolean(
    research.identity?.module_enabled &&
    research.identity?.workspace_enabled &&
    research.identity?.sections?.research_chain &&
    research.canSee("research_chain")
  );
  const canSeeSummary = Boolean(research.identity?.sections?.reports && research.canSee("summary"));

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
    try {
      const result = await fetchProjects(workspaceSlug);
      if (administrativeVersion.current !== version) return;
      const administrative = result.filter((project) => !project.is_research_project && !project.archived_at);
      setAdministrativeProjects(administrative);
      setAdministrativeState(administrative.length ? "ready" : "empty");
    } catch {
      if (administrativeVersion.current !== version) return;
      setAdministrativeProjects([]);
      setAdministrativeState("error");
    }
  }, [fetchProjects, workspaceSlug]);

  const loadReportSummary = useCallback(async () => {
    if (!canSeeSummary) {
      setReportSummary(null);
      setReportState("empty");
      return;
    }
    const version = ++reportVersion.current;
    setReportState("loading");
    try {
      const summary = await research.fetchReportSummary(workspaceSlug, { report_type: "WEEKLY" });
      if (reportVersion.current !== version) return;
      setReportSummary(summary);
      setReportState("ready");
    } catch (error) {
      if (reportVersion.current !== version) return;
      setReportSummary(null);
      setReportState(
        (error as { error_code?: string })?.error_code === "research_permission_denied" ? "forbidden" : "error"
      );
    }
  }, [canSeeSummary, research, workspaceSlug]);

  useEffect(() => {
    if (canSeeResearch) void loadChains();
    else setChainState("forbidden");
  }, [canSeeResearch, loadChains, refreshToken]);

  useEffect(() => {
    void loadAdministrativeProjects();
  }, [loadAdministrativeProjects, refreshToken]);

  useEffect(() => {
    void loadReportSummary();
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

  return (
    <div className="flex min-w-0 flex-col gap-5">
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
          <Button variant="secondary" size="sm" onClick={refresh}>
            {t("research.common.refresh")}
          </Button>
        </div>
      </header>

      <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-2" data-testid="workspace-home-columns">
        <div className="min-w-0 space-y-5">
          <section
            className="overflow-hidden rounded-xl bg-surface-2"
            aria-label={t("research.home_workbench.research_overview")}
          >
            <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-14 font-semibold text-primary">{t("research.home_workbench.research_overview")}</h2>
                <p className="mt-0.5 text-11 text-tertiary">{t("research.home_workbench.research_hint")}</p>
              </div>
              <Link href={`/${workspaceSlug}/research/chains`} className="text-12 text-accent-primary hover:underline">
                {t("research.home_workbench.all_research")}
              </Link>
            </header>
            <div className="border-t border-subtle">
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
                  <div className="grid grid-cols-3 divide-x divide-subtle">
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
                  <ul className="divide-y divide-subtle border-t border-subtle" role="list">
                    {visibleChains.slice(0, 4).map((chain) => (
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
            </div>
          </section>

          <section
            className="overflow-hidden rounded-xl bg-surface-2"
            aria-label={t("research.home_workbench.administrative_overview")}
          >
            <header className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-14 font-semibold text-primary">
                  {t("research.home_workbench.administrative_overview")}
                </h2>
                <p className="mt-0.5 text-11 text-tertiary">{t("research.home_workbench.administrative_hint")}</p>
              </div>
              <Link href={`/${workspaceSlug}/projects`} className="text-12 text-accent-primary hover:underline">
                {t("research.home_workbench.all_administrative")}
              </Link>
            </header>
            <div className="border-t border-subtle">
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
                  {administrativeProjects.slice(0, 4).map((project) => (
                    <li
                      key={project.id}
                      className="flex items-center justify-between gap-3 px-4 py-3 hover:bg-surface-1"
                    >
                      <Link
                        href={`/${workspaceSlug}/projects/${project.id}/issues`}
                        className="min-w-0 truncate text-13 font-medium text-primary hover:text-accent-primary"
                      >
                        {project.name}
                      </Link>
                      <span className="shrink-0 text-11 text-tertiary tabular-nums">
                        {project.updated_at
                          ? formatResearchDate(new Date(project.updated_at).toISOString(), currentLocale)
                          : "-"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>

        <div className="min-w-0 space-y-5">
          <ResearchTodoEnvelopeList
            key={`todo-${refreshToken}`}
            workspaceSlug={workspaceSlug}
            periodDays={periodDays}
            limit={8}
          />
          <section
            className="overflow-hidden rounded-xl bg-surface-2 p-4"
            aria-label={t("research.home_workbench.recent_activity")}
          >
            <RecentActivityWidget
              key={`recent-${refreshToken}`}
              workspaceSlug={workspaceSlug}
              showFilterSelect={false}
              title={t("research.home_workbench.recent_activity")}
            />
          </section>
          <section
            className="overflow-hidden rounded-xl bg-surface-2"
            aria-label={t("research.home_workbench.report_summary")}
          >
            <header className="px-4 pt-3">
              <h2 className="text-14 font-semibold text-primary">{t("research.home_workbench.report_summary")}</h2>
              <p className="mt-0.5 text-11 text-tertiary">
                {reportSummary
                  ? `${reportSummary.period_key} · ${reportSummary.period_start} ~ ${reportSummary.period_end}`
                  : ""}
              </p>
            </header>
            {reportState === "loading" && (
              <div className="p-4" role="status" aria-busy="true">
                <Skeleton.Item height="72px" width="100%" />
              </div>
            )}
            {reportState === "error" && (
              <p className="p-4 text-12 text-secondary" role="alert">
                {t("research.home_workbench.report_error")}
              </p>
            )}
            {reportState === "forbidden" && (
              <p className="p-4 text-12 text-secondary">{t("research.home_summary.forbidden")}</p>
            )}
            {(reportState === "empty" || reportState === "ready") && (
              <div className="grid min-w-0 grid-cols-2 divide-x divide-y divide-subtle border-t border-subtle sm:grid-cols-4">
                {[
                  { label: t("research.summary.not_submitted"), value: reportSummary?.counts.not_submitted ?? 0 },
                  { label: t("research.summary.needs_revision"), value: reportSummary?.counts.needs_revision ?? 0 },
                  { label: t("research.summary.submitted"), value: reportSummary?.counts.submitted ?? 0 },
                  { label: t("research.summary.accepted"), value: reportSummary?.counts.accepted ?? 0 },
                ].map((item) => (
                  <div key={item.label} className="min-w-0 px-4 py-3">
                    <p className="truncate text-11 text-tertiary">{item.label}</p>
                    <p className="mt-1 text-18 font-semibold text-primary tabular-nums">{item.value}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
});
