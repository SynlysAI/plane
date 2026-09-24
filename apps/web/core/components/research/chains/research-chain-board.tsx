/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import { getButtonStyling } from "@plane/propel/button";
import { Skeleton } from "@plane/propel/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import type { TResearchChain } from "@plane/types";
// components
import { ResearchListState } from "@/components/research/common/research-list-state";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
// services
import { ResearchChainService } from "@/services/research/chain.service";

const chainService = new ResearchChainService();

type Props = {
  workspaceSlug: string;
};

/** Structured list of research chains: identity, status, owner, freshness and next action. */
export const ResearchChainBoard = function ResearchChainBoard({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const [chains, setChains] = useState<TResearchChain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      setChains(await chainService.getChains(workspaceSlug));
    } catch (caught) {
      if ((caught as { error_code?: string })?.error_code === "research_permission_denied") {
        setForbidden(true);
      }
      setError("load_failed");
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="space-y-2 p-5" role="status" aria-busy="true">
        {[0, 1, 2].map((row) => (
          <Skeleton.Item key={row} height="48px" width="100%" />
        ))}
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="p-5">
        <ResearchListState
          kind="forbidden"
          resource="reports"
          variant="detailed"
          config={{
            titleKey: "research.common.permission_denied",
            descriptionKey: "research.status.permission_denied.description",
          }}
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-5">
        <ResearchListState
          kind="error"
          resource="reports"
          onRetry={() => void load()}
          config={{
            titleKey: "research.status.load_failed.title",
            descriptionKey: "research.status.load_failed.description",
          }}
        />
      </div>
    );
  }

  if (!chains.length) {
    return (
      <div className="p-5">
        <ResearchListState
          kind="empty"
          resource="reports"
          config={{
            titleKey: "research.chains.empty",
            descriptionKey: "research.chains.description",
          }}
        />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-5">
      <Table>
        <caption className="sr-only">{t("research.nav.research_chain")}</caption>
        <TableHeader>
          <TableRow>
            <TableHead>{t("research.chains.project")}</TableHead>
            <TableHead>{t("research.chains.status")}</TableHead>
            <TableHead>{t("research.chains.visibility")}</TableHead>
            <TableHead>{t("research.chains.owner")}</TableHead>
            <TableHead className="text-right">{t("research.chains.updated_at")}</TableHead>
            <TableHead className="text-right">{t("research.approvals.columns.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {chains.map((chain) => (
            <TableRow key={chain.id} className="hover:bg-surface-2">
              <TableCell>
                <Link
                  href={`/${workspaceSlug}/research/chains/${chain.id}`}
                  className="font-medium text-primary hover:text-accent-primary"
                >
                  {chain.project_name ?? chain.project}
                </Link>
              </TableCell>
              <TableCell>
                <ResearchStatusBadge status={chain.status} size="sm">
                  {t(`research.chains.chain_status.${chain.status.toLowerCase()}`)}
                </ResearchStatusBadge>
              </TableCell>
              <TableCell className="text-secondary">
                {t(`research.chains.visibility.${chain.visibility.toLowerCase()}`)}
              </TableCell>
              <TableCell className="text-secondary">{chain.owner_name ?? chain.owner}</TableCell>
              <TableCell className="text-right text-tertiary tabular-nums">
                {new Date(chain.updated_at).toLocaleString()}
              </TableCell>
              <TableCell className="text-right">
                <Link
                  href={`/${workspaceSlug}/research/chains/${chain.id}`}
                  className={getButtonStyling("secondary", "base")}
                >
                  {t("research.chains.open")}
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
