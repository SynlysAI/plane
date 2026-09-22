/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TResearchChainNode } from "@plane/types";
// hooks
import { useResearch } from "@/hooks/store/use-research";
// services
import { ResearchChainService } from "@/services/research/chain.service";

const chainService = new ResearchChainService();

type Props = {
  workspaceSlug: string;
  chainId: string;
};

export const ResearchChainDetail = function ResearchChainDetail({ workspaceSlug, chainId }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const [nodes, setNodes] = useState<TResearchChainNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const agentEnabled = Boolean(research.identity?.sections?.research_agent);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setNodes(await chainService.getChainNodes(workspaceSlug, chainId));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [chainId, workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-2 p-5" role="status" aria-busy="true">
        {[0, 1].map((row) => (
          <div key={row} className="h-12 animate-pulse rounded-md bg-surface-2" />
        ))}
      </div>
    );
  }

  if (failed) {
    return (
      <div className="p-5">
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-md border border-subtle px-3 py-1.5 text-12 text-secondary hover:bg-surface-2"
        >
          {t("research.chains.refresh")}
        </button>
      </div>
    );
  }

  if (!nodes.length) {
    return (
      <div className="p-5">
        <p className="rounded-lg border border-subtle bg-surface-1 p-6 text-13 text-primary" role="status">
          {t("research.chains.nodes_empty")}
        </p>
      </div>
    );
  }

  return (
    <ul className="h-full space-y-2 overflow-y-auto p-5" role="list">
      {nodes.map((node) => (
        <li
          key={node.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-subtle bg-surface-1 p-4"
        >
          <div>
            <p className="text-13 font-medium text-primary">{node.title}</p>
            <p className="mt-1 text-11 text-tertiary">
              {node.node_type} · {node.status}
            </p>
          </div>
          {agentEnabled && (
            <Link
              href={`/${workspaceSlug}/research/chains/${chainId}/nodes/${node.id}/agent`}
              className="rounded-md bg-accent-primary px-3 py-1.5 text-12 text-on-color"
            >
              {t("research.chains.open_agent")}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
};
