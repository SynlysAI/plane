"use client";

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button, getButtonStyling } from "@plane/propel/button";
import { Skeleton } from "@plane/propel/skeleton";
import type { TResearchChain, TResearchChainNode, TResearchChainSnapshot } from "@plane/types";
// components
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
// hooks
import { useResearch } from "@/hooks/store/use-research";
// services
import { ResearchChainService } from "@/services/research/chain.service";

const chainService = new ResearchChainService();

const STATUS_PRIORITY: Record<TResearchChainNode["status"], number> = {
  WAITING_HUMAN: 0,
  NEEDS_REVISION: 1,
  FAILED: 2,
  ACTIVE: 3,
  DRAFT: 4,
  COMPLETED: 5,
  ARCHIVED: 6,
};

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
    [...nodes].sort(
      (left, right) =>
        STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] ||
        new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
    )[0] ?? null;
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
  const currentChain =
    summary?.chains.find((chain) => chain.id === summary.currentNode?.chain) ??
    // eslint-disable-next-line unicorn/no-array-sort
    [...(summary?.chains ?? [])].sort(
      (left, right) => new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
    )[0];
  const currentNode = summary?.currentNode ?? null;
  const latestSnapshot = summary?.latestSnapshot ?? null;

  return (
    <section
      className="overflow-hidden rounded-xl border border-subtle bg-surface-1"
      aria-label={t("research.home_summary.title")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle bg-surface-2 px-4 py-2.5">
        <div className="min-w-0">
          <h3 className="text-12 font-semibold text-primary">{t("research.home_summary.title")}</h3>
          <p className="mt-0.5 text-11 text-tertiary">{t("research.home_summary.snapshot")}</p>
        </div>
        <div className="flex items-center divide-x divide-subtle text-11 text-tertiary tabular-nums">
          <span className="pr-3">
            <span className="text-14 font-semibold text-primary">{activeCount}</span>{" "}
            {t("research.home_summary.active_chains")}
          </span>
          <span className="pl-3">
            <span className="text-14 font-semibold text-primary">{todoCount}</span> {t("research.home_summary.todos")}
          </span>
        </div>
      </div>

      {state === "ready" && currentChain ? (
        <div className="px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Link
                  href={`/${workspaceSlug}/research/chains/${currentChain.id}`}
                  className="truncate text-18 font-semibold text-primary hover:text-accent-primary"
                >
                  {currentChain.project_name ?? currentChain.project}
                </Link>
                <ResearchStatusBadge status={currentChain.status}>
                  {t(`research.chains.chain_status.${currentChain.status.toLowerCase()}`)}
                </ResearchStatusBadge>
              </div>
              {currentNode && (
                <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-surface-2 px-3 py-2.5">
                  <span className="text-11 text-tertiary">{t("research.chains.current_node")}</span>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="truncate text-13 font-medium text-primary">{currentNode.title}</span>
                    <ResearchStatusBadge status={currentNode.status} size="sm">
                      {t(`research.chains.node_status.${currentNode.status.toLowerCase()}`)}
                    </ResearchStatusBadge>
                  </div>
                </div>
              )}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
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
