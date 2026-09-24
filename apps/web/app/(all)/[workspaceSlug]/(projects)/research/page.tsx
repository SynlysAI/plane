/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
import { useParams, useSearchParams } from "react-router";
// plane imports
import { ChevronRightOutline } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
import { getButtonStyling } from "@plane/propel/button";
import { TabNavigationItem, TabNavigationList } from "@plane/propel/tab-navigation";
import type { TResearchChain } from "@plane/types";
// components
import { ResearchHomeSummaryCard } from "@/components/research/common/research-home-summary-card";
import { ResearchTodoIndex } from "@/components/research/common/research-todo-index";
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { ResearchChainPortal } from "@/components/research/chains/research-chain-portal";
import { ResearchReportSummaryBoard } from "@/components/research/reports/report-summary-board";
import { ResearchPiAggregateBoard } from "@/components/research/pi/pi-aggregate-board";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
// hooks
import { useResearch } from "@/hooks/store/use-research";
// services
import { ResearchChainService } from "@/services/research/chain.service";

const chainService = new ResearchChainService();

const BUSINESS_CARDS = [
  { key: "reports", path: "reports", titleKey: "research.nav.reports", section: "reports" },
  { key: "summary", path: "reports/summary", titleKey: "research.nav.summary", section: "reports" },
  { key: "projects", path: "projects", titleKey: "research.nav.projects", section: "reports" },
  { key: "approvals", path: "approvals", titleKey: "research.nav.approvals", section: "approvals" },
] as const;

const SETTINGS_CARDS = [
  { key: "org", path: "settings/org", titleKey: "research.nav.org_settings", section: "org" },
  { key: "system", path: "settings/system", titleKey: "research.nav.system", section: "org" },
  { key: "templates", path: "settings/templates", titleKey: "research.nav.templates", section: "reports" },
  { key: "identity", path: "settings/identity", titleKey: "research.nav.identity", section: "org" },
  { key: "platform", path: "settings/platform", titleKey: "research.nav.platform", section: "org" },
  { key: "audit", path: "audit", titleKey: "research.nav.audit", section: "org" },
] as const;

const PERIOD_OPTIONS = [
  { value: "30", labelKey: "research.overview.period_30" },
  { value: "90", labelKey: "research.overview.period_90" },
  { value: "all", labelKey: "research.overview.period_all" },
] as const;

type TPeriod = "30" | "90" | "all";

function WorkspaceResearchOverviewPage() {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const research = useResearch();
  const [searchParams] = useSearchParams();
  const view = searchParams.get("view");
  const [period, setPeriod] = useState<TPeriod>("30");
  const [chains, setChains] = useState<TResearchChain[]>([]);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [chainsError, setChainsError] = useState(false);

  const loadChains = useCallback(async () => {
    if (!workspaceSlug || !research.canSee("research_chain")) return;
    setChainsError(false);
    try {
      setChains(await chainService.getChains(workspaceSlug));
    } catch {
      setChainsError(true);
    } finally {
      setRefreshedAt(new Date());
    }
  }, [research, workspaceSlug]);

  useEffect(() => {
    void loadChains();
  }, [loadChains]);

  const isCardVisible = (card: { key: string; section: string }) =>
    Boolean(research.identity?.sections?.[card.section as keyof typeof research.identity.sections]) &&
    research.canSee(card.key);
  const businessCards = BUSINESS_CARDS.filter(isCardVisible);
  const settingsCards = SETTINGS_CARDS.filter(isCardVisible);
  const periodDays = period === "all" ? null : Number(period);
  const periodStart = periodDays ? Date.now() - periodDays * 86400000 : 0;
  const visibleChains = chains.filter((chain) => new Date(chain.updated_at).getTime() >= periodStart);
  const currentChain = visibleChains[0];

  if (workspaceSlug && view === "report_submission" && research.canSee("summary")) {
    return (
      <ResearchPageShell
        titleKey="research.nav.summary"
        descriptionKey="research.summary.description"
        section="reports"
        navKey="summary"
      >
        <ResearchReportSummaryBoard workspaceSlug={workspaceSlug} />
      </ResearchPageShell>
    );
  }

  const headerActions =
    workspaceSlug && research.canSee("research_chain") ? (
      <Link href={`/${workspaceSlug}/research/chains`} className={getButtonStyling("primary", "base")}>
        {t("research.overview.open_chain")}
      </Link>
    ) : undefined;

  const headerMetadata = refreshedAt ? (
    <span>{`${t("research.overview.refreshed_at")} ${refreshedAt.toLocaleTimeString()}`}</span>
  ) : undefined;

  const compactNavItems = [...businessCards, ...settingsCards];

  return (
    <ResearchPageShell
      titleKey="research.nav.overview"
      descriptionKey="research.overview.description"
      navKey="overview"
      actions={headerActions}
      metadata={headerMetadata}
    >
      <div className="flex h-full flex-col overflow-hidden">
        <nav
          aria-label={t("research.overview.period")}
          className="flex items-center justify-between gap-3 border-b border-subtle px-5 py-2"
        >
          <TabNavigationList>
            {PERIOD_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setPeriod(option.value)}
                aria-pressed={period === option.value}
                className="whitespace-nowrap"
              >
                <TabNavigationItem isActive={period === option.value}>{t(option.labelKey)}</TabNavigationItem>
              </button>
            ))}
          </TabNavigationList>
          {currentChain && (
            <Link
              href={`/${workspaceSlug}/research/chains/${currentChain.id}`}
              className="text-12 text-accent-primary hover:underline"
            >
              {t("research.home_summary.open_chain")}
            </Link>
          )}
        </nav>

        <div className="h-full overflow-y-auto bg-canvas p-5">
          {workspaceSlug && research.canSee("research_chain") && (
            <ResearchHomeSummaryCard workspaceSlug={workspaceSlug} />
          )}

          <div className="mt-5">
            {workspaceSlug && <ResearchTodoIndex workspaceSlug={workspaceSlug} periodDays={periodDays} limit={12} />}
          </div>

          <section className="mt-5 overflow-hidden rounded-xl bg-surface-2">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div>
                <h3 className="text-13 font-semibold text-primary">{t("research.overview.chain_section")}</h3>
                <p className="mt-0.5 text-11 text-tertiary">{t("research.overview.chain_section_hint")}</p>
              </div>
              {workspaceSlug && research.canSee("summary") && (
                <Link
                  href={`/${workspaceSlug}/research?view=report_submission`}
                  className="text-12 text-accent-primary hover:underline"
                >
                  {t("research.overview.open_summary")}
                </Link>
              )}
            </div>
            <div aria-label={t("research.portal.title")}>
              {chainsError ? (
                <p className="p-4 text-12 text-secondary" role="alert">
                  {t("research.portal.load_failed")}
                </p>
              ) : visibleChains.length ? (
                <ul className="divide-y divide-subtle" role="list">
                  {visibleChains.slice(0, 6).map((chain) => (
                    <li key={chain.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-1">
                      <Link
                        href={`/${workspaceSlug}/research/chains/${chain.id}`}
                        className="min-w-0 flex-1 truncate text-13 text-primary hover:text-accent-primary"
                      >
                        {chain.project_name ?? chain.project}
                      </Link>
                      <ResearchStatusBadge status={chain.status} size="sm">
                        {t(`research.chains.chain_status.${chain.status.toLowerCase()}`)}
                      </ResearchStatusBadge>
                      <span className="w-24 shrink-0 text-right text-11 text-tertiary tabular-nums">
                        {new Date(chain.updated_at).toLocaleDateString()}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="p-4 text-12 text-secondary">{t("research.chains.empty")}</p>
              )}
            </div>
          </section>

          {workspaceSlug && !research.isIaV2Enabled && research.canSee("research_chain") && (
            <div className="mt-5">
              <ResearchChainPortal workspaceSlug={workspaceSlug} />
            </div>
          )}
          {workspaceSlug && research.canSee("dashboard") && (
            <section className="mt-5" aria-label={t("research.pi.overview")}>
              <ResearchPiAggregateBoard workspaceSlug={workspaceSlug} />
            </section>
          )}

          {!research.isIaV2Enabled && compactNavItems.length > 0 && (
            <nav className="mt-5" aria-label={t("research.nav.group")}>
              <h3 className="text-11 font-medium tracking-wide text-tertiary uppercase">{t("research.nav.group")}</h3>
              <ul className="mt-2 divide-y divide-subtle overflow-hidden rounded-xl bg-surface-2" role="list">
                {compactNavItems.map((card) => (
                  <li key={card.key}>
                    <Link
                      href={`/${workspaceSlug}/research/${card.path}`}
                      className="group flex items-center justify-between gap-3 px-4 py-2.5 transition-colors hover:bg-surface-1"
                    >
                      <div className="min-w-0">
                        <p className="text-13 font-medium text-primary">{t(card.titleKey)}</p>
                        <p className="mt-0.5 truncate text-11 text-tertiary">
                          {t(`research.overview.${card.key}_hint`)}
                        </p>
                      </div>
                      <ChevronRightOutline className="size-4 shrink-0 text-tertiary transition-colors group-hover:text-secondary" />
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </div>
    </ResearchPageShell>
  );
}

export default observer(WorkspaceResearchOverviewPage);
