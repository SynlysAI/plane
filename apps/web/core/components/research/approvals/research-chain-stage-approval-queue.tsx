"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Skeleton } from "@plane/propel/skeleton";
import type { TResearchChain, TResearchChainNode, TResearchChainStageApproval } from "@plane/types";

import { ResearchChainStageApprovalPanel } from "@/components/research/chains/research-chain-stage-approval-panel";
import { ResearchChainWorkbenchPeek } from "@/components/research/chains/research-chain-workbench-peek";
import { useResearchChainKnowledge } from "@/components/research/chains/use-research-chain-knowledge";
import { ResearchChainService } from "@/services/research/chain.service";

const chainService = new ResearchChainService();

export type TChainStageApprovalQueueItem = {
  id: string;
  object_id: string;
  title: string;
  href: string;
  context?: string | null;
  requester?: { display_name: string } | null;
};

type TQueueContext = {
  chain: TResearchChain;
  nodes: TResearchChainNode[];
  stage: TResearchChainStageApproval;
};

type Props = {
  workspaceSlug: string;
  items: TChainStageApprovalQueueItem[];
  activeId: string;
  onHandled: (id: string) => void;
  onClose: () => void;
};

/** 从阶段审批深链中提取科研链 ID。 */
function chainIdFromHref(href: string) {
  return href.match(/\/research\/chains\/([^/?#]+)/)?.[1] ?? null;
}

/** 从深链 query 中读取指定参数，兼容相对路径。 */
function hrefParam(href: string, key: string) {
  const query = href.split("?", 2)[1] ?? "";
  return new URLSearchParams(query).get(key);
}

/** 右侧连续处理科研链阶段审批的队列 Peek。 */
export function ResearchChainStageApprovalQueue({ workspaceSlug, items, activeId, onHandled, onClose }: Props) {
  const { t } = useTranslation();
  const activeIndex = items.findIndex((item) => item.id === activeId);
  const activeItem = activeIndex >= 0 ? items[activeIndex] : null;
  const chainId = activeItem ? chainIdFromHref(activeItem.href) : null;
  const [context, setContext] = useState<TQueueContext | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const requestVersion = useRef(0);
  const knowledgeNodeId = hrefParam(activeItem?.href ?? "", "node") ?? context?.stage.submitted_node ?? "";
  const knowledge = useResearchChainKnowledge(workspaceSlug, chainId ?? "", knowledgeNodeId);

  const load = useCallback(async () => {
    if (!activeItem || !chainId) {
      setContext(null);
      setState("error");
      return;
    }
    const request = ++requestVersion.current;
    setState("loading");
    try {
      const [chain, nodes, summary] = await Promise.all([
        chainService.getChain(workspaceSlug, chainId),
        chainService.getChainNodes(workspaceSlug, chainId),
        chainService.getChainStageApprovals(workspaceSlug, chainId),
      ]);
      const stage = summary.stages.find((item) => item.id === activeItem.object_id);
      if (!stage) throw new Error("stage not found");
      if (request !== requestVersion.current) return;
      setContext({ chain, nodes, stage });
      setState("ready");
    } catch {
      if (request !== requestVersion.current) return;
      setContext(null);
      setState("error");
    }
  }, [activeItem, chainId, workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!activeItem) return null;

  const header = (
    <header className="flex items-start justify-between gap-3 border-b border-subtle px-4 py-3">
      <div className="min-w-0">
        <p className="text-11 text-tertiary">
          {t("research.todo.queue_position", { index: activeIndex + 1, count: items.length })}
        </p>
        <h3 className="mt-1 truncate text-14 font-semibold text-primary" title={activeItem.title}>
          {activeItem.title}
        </h3>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Link href={activeItem.href} className="text-12 text-accent-primary hover:underline">
          {t("research.todo.queue_original_detail")}
        </Link>
        <button type="button" className="text-12 text-secondary hover:text-primary" onClick={onClose}>
          {t("research.chains.workflow.close_peek")}
        </button>
      </div>
    </header>
  );

  return (
    <ResearchChainWorkbenchPeek
      title={t("research.todo.queue_title")}
      onClose={onClose}
      size="wide"
      header={header}
      bodyClassName="min-h-0 flex-1 overflow-y-auto"
    >
      {state === "loading" && (
        <div className="space-y-3 p-4" role="status" aria-busy="true">
          <Skeleton.Item height="44px" width="100%" />
          <Skeleton.Item height="160px" width="100%" />
          <Skeleton.Item height="44px" width="100%" />
        </div>
      )}
      {state === "error" && (
        <div className="p-4" role="alert">
          <p className="text-13 font-medium text-primary">{t("research.todo.queue_load_failed")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {t("research.status.retry")}
            </Button>
            <Link href={activeItem.href} className="text-12 text-accent-primary hover:underline">
              {t("research.todo.queue_original_detail")}
            </Link>
          </div>
        </div>
      )}
      {state === "ready" && context && (
        <ResearchChainStageApprovalPanel
          workspaceSlug={workspaceSlug}
          chainId={context.chain.id}
          stage={context.stage}
          nodes={context.nodes}
          preferredNodeId={hrefParam(activeItem.href, "node")}
          applicantName={context.chain.owner_name ?? activeItem.requester?.display_name ?? null}
          defaultExpanded
          knowledge={knowledge}
          onStageChanged={() => undefined}
          onDecision={async () => onHandled(activeItem.id)}
        />
      )}
    </ResearchChainWorkbenchPeek>
  );
}
