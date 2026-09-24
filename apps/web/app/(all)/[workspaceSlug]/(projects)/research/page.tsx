/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
import { useParams, useSearchParams } from "react-router";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TResearchChain } from "@plane/types";
// components
import { ResearchTodoIndex } from "@/components/research/common/research-todo-index";
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { ResearchChainPortal } from "@/components/research/chains/research-chain-portal";
import { ResearchReportSummaryBoard } from "@/components/research/reports/report-summary-board";
import { ResearchPiAggregateBoard } from "@/components/research/pi/pi-aggregate-board";
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

  const controls = (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1 text-11 text-secondary">
        <span>{t("research.overview.period")}</span>
        <select
          value={period}
          onChange={(event) => setPeriod(event.target.value as TPeriod)}
          aria-label={t("research.overview.period")}
          className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-11 text-primary"
        >
          <option value="30">{t("research.overview.period_30")}</option>
          <option value="90">{t("research.overview.period_90")}</option>
          <option value="all">{t("research.overview.period_all")}</option>
        </select>
      </label>
      <span className="text-11 text-tertiary">
        {refreshedAt ? `${t("research.overview.refreshed_at")} ${refreshedAt.toLocaleTimeString()}` : ""}
      </span>
      {workspaceSlug && research.canSee("research_chain") && (
        <Link
          href={`/${workspaceSlug}/research/chains`}
          className="rounded-md bg-accent-primary px-3 py-1.5 text-11 text-on-color"
        >
          {t("research.overview.open_chain")}
        </Link>
      )}
    </div>
  );

  return (
    <ResearchPageShell
      titleKey="research.nav.overview"
      descriptionKey="research.overview.description"
      navKey="overview"
      actions={controls}
    >
      <div className="h-full overflow-y-auto p-5">
        {workspaceSlug && <ResearchTodoIndex workspaceSlug={workspaceSlug} periodDays={periodDays} limit={12} />}

        <div className="mt-6 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <section className="rounded-xl border border-subtle bg-surface-1" aria-label={t("research.portal.title")}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle px-4 py-3">
              <div>
                <h3 className="text-13 font-semibold text-primary">{t("research.overview.chain_section")}</h3>
                <p className="mt-0.5 text-11 text-tertiary">{t("research.overview.chain_section_hint")}</p>
              </div>
              {currentChain && (
                <Link
                  href={`/${workspaceSlug}/research/chains/${currentChain.id}`}
                  className="text-12 text-accent-primary hover:underline"
                >
                  {t("research.home_summary.open_chain")}
                </Link>
              )}
            </div>
            {chainsError ? (
              <p className="p-4 text-12 text-secondary">{t("research.portal.load_failed")}</p>
            ) : visibleChains.length ? (
              <ul className="divide-y divide-subtle" role="list">
                {visibleChains.slice(0, 6).map((chain) => (
                  <li key={chain.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <Link
                      href={`/${workspaceSlug}/research/chains/${chain.id}`}
                      className="min-w-0 flex-1 truncate text-12 text-primary hover:text-accent-primary"
                    >
                      {chain.project}
                    </Link>
                    <span className="text-11 text-tertiary">{chain.status}</span>
                    <span className="text-11 text-tertiary">{new Date(chain.updated_at).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-4 text-12 text-secondary">{t("research.chains.empty")}</p>
            )}
          </section>

          <section className="rounded-xl border border-subtle bg-surface-1 p-4" aria-label={t("research.nav.summary")}>
            <h3 className="text-13 font-semibold text-primary">{t("research.nav.summary")}</h3>
            <p className="mt-1 text-11 text-tertiary">{t("research.summary.description")}</p>
            <Link
              href={`/${workspaceSlug}/research?view=report_submission`}
              className="mt-3 inline-block rounded-md border border-subtle px-3 py-1.5 text-12 text-secondary hover:bg-surface-2"
            >
              {t("research.overview.open_summary")}
            </Link>
          </section>
        </div>

        {workspaceSlug && !research.isIaV2Enabled && research.canSee("research_chain") && (
          <div className="mt-6">
            <ResearchChainPortal workspaceSlug={workspaceSlug} />
          </div>
        )}
        {workspaceSlug && research.canSee("dashboard") && (
          <section className="mt-6 overflow-hidden rounded-xl border border-subtle bg-surface-1">
            <ResearchPiAggregateBoard workspaceSlug={workspaceSlug} />
          </section>
        )}

        {!research.isIaV2Enabled && (
          <>
            <section className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              {businessCards.map((card) => (
                <Link
                  key={card.key}
                  href={`/${workspaceSlug}/research/${card.path}`}
                  className="rounded-lg border border-subtle bg-surface-1 p-4 transition-colors hover:bg-surface-2"
                >
                  <p className="text-13 font-medium text-primary">{t(card.titleKey)}</p>
                  <p className="mt-1 text-11 text-tertiary">{t(`research.overview.${card.key}_hint`)}</p>
                </Link>
              ))}
            </section>
            {settingsCards.length > 0 && (
              <section className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {settingsCards.map((card) => (
                  <Link
                    key={card.key}
                    href={`/${workspaceSlug}/research/${card.path}`}
                    className="rounded-lg border border-subtle bg-surface-1 p-4 transition-colors hover:bg-surface-2"
                  >
                    <p className="text-13 font-medium text-primary">{t(card.titleKey)}</p>
                    <p className="mt-1 text-11 text-tertiary">{t(`research.overview.${card.key}_hint`)}</p>
                  </Link>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </ResearchPageShell>
  );
}

export default observer(WorkspaceResearchOverviewPage);
