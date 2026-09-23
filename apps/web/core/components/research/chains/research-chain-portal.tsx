"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
// plane imports
import type { TIntegrationConnection } from "@plane/types";
import { useTranslation } from "@plane/i18n";
// hooks
import { useResearch } from "@/hooks/store/use-research";
// services
import { ResearchChainService } from "@/services/research/chain.service";
import { ResearchIntegrationService } from "@/services/research/integration.service";
import type { TResearchChain } from "@plane/types";

const chainService = new ResearchChainService();
const integrationService = new ResearchIntegrationService();

type Props = {
  workspaceSlug: string;
};

type TPortalState = "loading" | "empty" | "ready" | "forbidden" | "error";

/** The fixed-order Research Chain area on the research welcome page. */
export const ResearchChainPortal = function ResearchChainPortal({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const [chains, setChains] = useState<TResearchChain[]>([]);
  const [connections, setConnections] = useState<TIntegrationConnection[]>([]);
  const [state, setState] = useState<TPortalState>("loading");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const visibleChains = await chainService.getChains(workspaceSlug);
      setChains(visibleChains);
      setState(visibleChains.length ? "ready" : "empty");
      const integrationPayload = await integrationService.getConnections(workspaceSlug).catch(() => null);
      setConnections(integrationPayload?.results ?? []);
    } catch (error) {
      const errorCode = (error as { error_code?: string })?.error_code;
      setState(errorCode === "research_permission_denied" ? "forbidden" : "error");
    }
  }, [workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentChain = chains[0];
  const activeCount = chains.filter((chain) => chain.status === "ACTIVE").length;
  const ragportal = connections.find((connection) => connection.system === "RAGPORTAL");
  const ragStatus = ragportal?.is_enabled ? (ragportal.health_status ?? "UNKNOWN") : ("UNKNOWN" as const);
  const agentAvailable = Boolean(research.identity?.sections?.research_agent);
  const updatedTime = currentChain ? new Date(currentChain.updated_at) : null;
  const updatedLabel =
    updatedTime instanceof Date && !Number.isNaN(updatedTime.getTime()) ? updatedTime.toLocaleString() : "";

  return (
    <section className="mb-6 space-y-3" aria-label={t("research.portal.title")}>
      <div className="rounded-lg border border-subtle bg-surface-1 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-13 font-medium text-primary">{t("research.portal.current_chain")}</h3>
            <p className="mt-1 text-11 text-tertiary">
              {state === "loading" && t("research.portal.loading")}
              {state === "forbidden" && t("research.common.permission_denied")}
              {state === "error" && t("research.portal.load_failed")}
              {state === "empty" && t("research.chains.empty")}
              {state === "ready" && currentChain && (
                <>
                  {t("research.portal.chain_summary", {
                    active: activeCount,
                    total: chains.length,
                  })}
                  {updatedLabel && <span className="ml-2">{updatedLabel}</span>}
                </>
              )}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {state === "error" && (
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-md border border-subtle px-3 py-1.5 text-12 text-secondary hover:bg-surface-2"
              >
                {t("research.portal.retry")}
              </button>
            )}
            {currentChain && (
              <Link
                href={`/${workspaceSlug}/research/chains/${currentChain.id}`}
                className="rounded-md bg-accent-primary px-3 py-1.5 text-12 text-on-color"
              >
                {t("research.portal.open_chain")}
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="rounded-lg border border-subtle bg-surface-1 p-4">
          <h4 className="text-12 font-medium text-primary">{t("research.portal.todo_title")}</h4>
          <div className="mt-3 flex flex-col gap-2">
            {research.canSee("reviews") && (
              <Link href={`/${workspaceSlug}/research/reviews`} className="text-12 text-accent-primary">
                {t("research.overview.open_reviews")}
              </Link>
            )}
            {research.canSee("approvals") && (
              <Link href={`/${workspaceSlug}/research/approvals`} className="text-12 text-accent-primary">
                {t("research.overview.open_approvals")}
              </Link>
            )}
            {research.canSee("reports") && (
              <Link
                href={`/${workspaceSlug}/research/reports?status=NEEDS_REVISION&mine=true`}
                className="text-12 text-accent-primary"
              >
                {t("research.overview.open_revisions")}
              </Link>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-subtle bg-surface-1 p-4">
          <h4 className="text-12 font-medium text-primary">{t("research.portal.snapshot_title")}</h4>
          <p className="mt-2 text-11 text-tertiary">{t("research.portal.snapshot_empty")}</p>
        </div>

        <div className="rounded-lg border border-subtle bg-surface-1 p-4">
          <h4 className="text-12 font-medium text-primary">{t("research.portal.agent_title")}</h4>
          <p className="mt-2 text-11 text-tertiary">
            {agentAvailable ? t("research.portal.agent_hint") : t("research.portal.agent_unavailable")}
          </p>
          {agentAvailable && currentChain && (
            <Link
              href={`/${workspaceSlug}/research/chains/${currentChain.id}`}
              className="mt-3 inline-block rounded-md border border-subtle px-3 py-1.5 text-12 text-secondary hover:bg-surface-2"
            >
              {t("research.portal.open_agent")}
            </Link>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-subtle bg-surface-1 p-4">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-12 font-medium text-primary">RAGPortal</h4>
            <span className="rounded bg-surface-2 px-2 py-1 text-11 text-tertiary">
              {t(`research.portal.status_${ragStatus.toLowerCase()}`)}
            </span>
          </div>
          <p className="mt-2 text-11 text-tertiary">{t("research.portal.ragportal_hint")}</p>
        </div>
        <div className="rounded-lg border border-subtle bg-surface-1 p-4">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-12 font-medium text-primary">Synlora</h4>
            <span className="rounded bg-surface-2 px-2 py-1 text-11 text-tertiary">
              {agentAvailable ? t("research.portal.status_ok") : t("research.portal.status_unknown")}
            </span>
          </div>
          <p className="mt-2 text-11 text-tertiary">{t("research.portal.synlora_hint")}</p>
        </div>
      </div>
    </section>
  );
};
