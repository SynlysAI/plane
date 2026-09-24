"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TResearchChain, TResearchChainNode, TResearchChainSnapshot } from "@plane/types";
// hooks
import { useResearch } from "@/hooks/store/use-research";
// services
import { ResearchChainService } from "@/services/research/chain.service";

const chainService = new ResearchChainService();

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
export function ResearchHomeSummaryCard({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const [state, setState] = useState<TSummaryState>("loading");
  const [summary, setSummary] = useState<TChainSummary | null>(null);

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
    if (research.identity?.sections?.research_chain && research.canSee("research_chain")) void load();
  }, [load, research]);

  if (!research.identity?.module_enabled || !research.identity?.workspace_enabled) return null;
  if (!research.identity?.sections?.research_chain || !research.canSee("research_chain")) return null;

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
      className="mb-7 rounded-xl border border-subtle bg-surface-1 p-5"
      aria-label={t("research.home_summary.title")}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-11 font-medium tracking-wide text-tertiary uppercase">{t("research.nav.group")}</p>
          <h2 className="mt-1 text-18 font-semibold text-primary">{t("research.home_summary.title")}</h2>
          <p className="mt-2 max-w-xl text-13 text-secondary">
            {state === "loading" && t("research.home_summary.loading")}
            {state === "forbidden" && t("research.home_summary.forbidden")}
            {state === "error" && t("research.home_summary.error")}
            {state === "empty" && t("research.home_summary.empty")}
            {state === "ready" && currentChain && (
              <>
                {t("research.home_summary.chain", { active: activeCount, total: summary?.chains.length ?? 0 })}
                {currentNode && (
                  <span className="mt-1 block truncate text-12 text-secondary">
                    {t("research.home_summary.current_node", { node: currentNode.title })}
                  </span>
                )}
              </>
            )}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <div className="grid grid-cols-2 gap-3 text-right">
            <div>
              <p className="text-22 font-semibold text-primary">{activeCount}</p>
              <p className="text-11 text-tertiary">{t("research.home_summary.active_chains")}</p>
            </div>
            <div>
              <p className="text-22 font-semibold text-primary">{todoCount}</p>
              <p className="text-11 text-tertiary">{t("research.home_summary.todos")}</p>
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {state === "error" && (
              <button
                type="button"
                onClick={() => void load()}
                className="rounded-md border border-subtle px-3 py-1.5 text-12 text-secondary transition-colors hover:bg-surface-2"
              >
                {t("research.status.retry")}
              </button>
            )}
            <Link
              href={`/${workspaceSlug}/research`}
              className="rounded-md border border-subtle px-3 py-1.5 text-12 text-secondary transition-colors hover:bg-surface-2"
            >
              {t("research.home_summary.open_overview")}
            </Link>
            {currentChain && (
              <Link
                href={`/${workspaceSlug}/research/chains/${currentChain.id}`}
                className="rounded-md bg-accent-primary px-3 py-1.5 text-12 text-on-color"
              >
                {t("research.home_summary.open_chain")}
              </Link>
            )}
          </div>
        </div>
      </div>
      <div className="mt-4 border-t border-subtle pt-3">
        <p className="text-11 text-tertiary">{t("research.home_summary.snapshot")}</p>
        <p className="mt-1 line-clamp-2 text-12 text-secondary">
          {state === "ready" && latestSnapshot?.summary
            ? latestSnapshot.summary
            : t("research.home_summary.snapshot_empty")}
        </p>
      </div>
    </section>
  );
}
