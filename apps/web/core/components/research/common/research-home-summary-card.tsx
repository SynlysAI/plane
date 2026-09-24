"use client";

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Badge } from "@plane/propel/badge";
import { Button, getButtonStyling } from "@plane/propel/button";
import { Skeleton } from "@plane/propel/skeleton";
import type { TResearchChain, TResearchChainNode, TResearchChainSnapshot } from "@plane/types";
// hooks
import { useResearch } from "@/hooks/store/use-research";
// services
import { ResearchChainService } from "@/services/research/chain.service";

const chainService = new ResearchChainService();

/** Low-saturation Badge variant for the research status dictionary (Phase 5 extracts this). */
const CHAIN_STATUS_VARIANTS = {
  ACTIVE: "brand",
  COMPLETED: "success",
  ARCHIVED: "neutral",
} as const;

/** Node statuses that require a human decision map to warning/danger semantics. */
const NODE_STATUS_VARIANTS = {
  DRAFT: "neutral",
  ACTIVE: "brand",
  WAITING_HUMAN: "warning",
  NEEDS_REVISION: "danger",
  COMPLETED: "success",
  FAILED: "danger",
  ARCHIVED: "neutral",
} as const;

type Props = {
  workspaceSlug: string;
};

type TSummaryState = "loading" | "ready" | "empty" | "forbidden" | "error";

type TChainSummary = {
  chains: TResearchChain[];
  currentNode: TResearchChainNode | null;
  latestSnapshot: TResearchChainSnapshot | null;
};

/** Read the newest visible chain, its active node and latest snapshot. */
async function loadChainSummary(workspaceSlug: string): Promise<TChainSummary> {
  const chains = await chainService.getChains(workspaceSlug);
  // eslint-disable-next-line unicorn/no-array-sort
  const currentChain = [...chains].sort(
    (left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
  )[0];
  if (!currentChain) return { chains, currentNode: null, latestSnapshot: null };

  const nodes = await chainService.getChainNodes(workspaceSlug, currentChain.id);
  const currentNode =
    // eslint-disable-next-line unicorn/no-array-sort
    [...nodes].sort((left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime())[0] ??
    null;
  const detail = currentNode
    ? await chainService.getChainNodeDetail(workspaceSlug, currentNode.id).catch(() => null)
    : null;
  const latestSnapshot = detail
    ? // eslint-disable-next-line unicorn/no-array-sort
      [...detail.snapshots].sort(
        (left, right) => new Date(right.created_at).getTime() - new Date(left.created_at).getTime()
      )[0]
    : null;
  return { chains, currentNode, latestSnapshot };
}

/** Compact research summary for the regular Plane workspace home. */
export const ResearchHomeSummaryCard = observer(function ResearchHomeSummaryCard({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const [state, setState] = useState<TSummaryState>("loading");
  const [summary, setSummary] = useState<TChainSummary | null>(null);
  const canLoadSummary = Boolean(
    research.identity?.module_enabled &&
    research.identity?.workspace_enabled &&
    research.identity?.sections?.research_chain &&
    research.canSee("research_chain")
  );

  useEffect(() => {
    if (research.identityWorkspaceSlug !== workspaceSlug || !research.identity) {
      void research.fetchIdentity(workspaceSlug).catch(() => undefined);
    }
  }, [research, workspaceSlug]);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const result = await loadChainSummary(workspaceSlug);
      setSummary(result);
      setState(result.chains.length ? "ready" : "empty");
    } catch (error) {
      setSummary(null);
      setState((error as { error_code?: string })?.error_code === "research_permission_denied" ? "forbidden" : "error");
    }
  }, [workspaceSlug]);

  useEffect(() => {
    if (canLoadSummary) void load();
  }, [canLoadSummary, load]);

  if (!canLoadSummary) return null;

  const activeCount = summary?.chains.filter((chain) => chain.status === "ACTIVE").length ?? 0;
  const todoCount =
    summary?.chains.length && summary.currentNode
      ? Number(summary.currentNode.status === "WAITING_HUMAN" || summary.currentNode.status === "NEEDS_REVISION")
      : 0;
  const currentChain = summary?.chains.find((chain) => chain.id === summary.currentNode?.chain);
  const currentNode = summary?.currentNode ?? null;
  const latestSnapshot = summary?.latestSnapshot ?? null;

  return (
    <section
      className="overflow-hidden rounded-xl border border-subtle bg-surface-1"
      aria-label={t("research.home_summary.title")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-13 font-semibold text-primary">{t("research.home_summary.title")}</h3>
          <p className="mt-0.5 text-11 text-tertiary">{t("research.home_summary.snapshot")}</p>
        </div>
        <div className="flex items-center divide-x divide-subtle text-11 text-tertiary">
          <span className="pr-3">
            <span className="font-semibold text-primary">{activeCount}</span> {t("research.home_summary.active_chains")}
          </span>
          <span className="pl-3">
            <span className="font-semibold text-primary">{todoCount}</span> {t("research.home_summary.todos")}
          </span>
        </div>
      </div>

      {state === "ready" && currentChain ? (
        <div className="px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Link
                  href={`/${workspaceSlug}/research/chains/${currentChain.id}`}
                  className="truncate text-14 font-medium text-primary hover:text-accent-primary"
                >
                  {currentChain.project_name ?? currentChain.project}
                </Link>
                <Badge variant={CHAIN_STATUS_VARIANTS[currentChain.status] ?? "neutral"}>
                  {t(`research.chains.chain_status.${currentChain.status.toLowerCase()}`)}
                </Badge>
              </div>
              {currentNode && (
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-12 text-secondary">
                  <Badge variant={NODE_STATUS_VARIANTS[currentNode.status] ?? "neutral"}>
                    {t(`research.chains.node_status.${currentNode.status.toLowerCase()}`)}
                  </Badge>
                  <span className="truncate">{currentNode.title}</span>
                </div>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Link href={`/${workspaceSlug}/research`} className={getButtonStyling("secondary", "base")}>
                {t("research.home_summary.open_overview")}
              </Link>
              <Link
                href={`/${workspaceSlug}/research/chains/${currentChain.id}`}
                className={getButtonStyling("primary", "base")}
              >
                {t("research.home_summary.open_chain")}
              </Link>
            </div>
          </div>
          <p className="mt-3 line-clamp-2 text-12 text-secondary">
            {latestSnapshot?.summary ?? t("research.home_summary.snapshot_empty")}
          </p>
        </div>
      ) : (
        <div className="px-4 py-4" role="status" aria-busy={state === "loading"}>
          {state === "loading" && (
            <Skeleton className="space-y-2" ariaLabel={t("research.home_summary.loading")}>
              <Skeleton.Item height="16px" width="50%" />
              <Skeleton.Item height="16px" width="66%" />
            </Skeleton>
          )}
          {state === "forbidden" && <p className="text-12 text-secondary">{t("research.home_summary.forbidden")}</p>}
          {state === "error" && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-12 text-secondary">{t("research.home_summary.error")}</p>
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                {t("research.status.retry")}
              </Button>
            </div>
          )}
          {state === "empty" && <p className="text-12 text-secondary">{t("research.home_summary.empty")}</p>}
        </div>
      )}
    </section>
  );
});
