/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import { getButtonStyling } from "@plane/propel/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import type { TResearchChain } from "@plane/types";
import { ResearchBrowseFilters } from "@/components/research/common/browse-filters";
import { useResearchBrowseQuery } from "@/components/research/common/browse-query";
import { useResearch } from "@/hooks/store/use-research";
import { Button } from "@plane/propel/button";
import { ListFilterField, ListFilterSelect } from "@plane/ui";
import {
  ResearchBrowseHeader,
  ResearchBrowseRefresh,
  ResearchBrowseToolbar,
} from "@/components/research/common/research-browse-toolbar";
// components
import { ResearchListState } from "@/components/research/common/research-list-state";
import { ResearchListSurface, ResearchTableSurface } from "@/components/research/common/research-data-surface";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { formatResearchDate, formatResearchDateTime } from "@/components/research/common/research-format";
import { ResearchTodoUrgency } from "@/components/research/common/research-todo-urgency";
// services
import { ResearchChainService } from "@/services/research/chain.service";

const chainService = new ResearchChainService();

type Props = {
  workspaceSlug: string;
};

/** Structured list of research chains: identity, status, owner, freshness and next action. */
export const ResearchChainBoard = function ResearchChainBoard({ workspaceSlug }: Props) {
  const { t, currentLocale } = useTranslation();
  const research = useResearch();
  const query = useResearchBrowseQuery();
  const version = useRef(0);
  const [page, setPage] = useState<{
    next_cursor: string;
    prev_cursor: string;
    next_page_results: boolean;
    prev_page_results: boolean;
  } | null>(null);
  const queryString = query.params.toString();
  const [chains, setChains] = useState<TResearchChain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    const currentVersion = ++version.current;
    setLoading(true);
    setError(null);
    setForbidden(false);
    try {
      const response = await chainService.getChainPage(
        workspaceSlug,
        Object.fromEntries(new URLSearchParams(queryString))
      );
      if (version.current !== currentVersion) return;
      setChains(response.results);
      setPage(response);
    } catch (caught) {
      if (version.current !== currentVersion) return;
      if ((caught as { error_code?: string })?.error_code === "research_permission_denied") {
        setForbidden(true);
      }
      setError("load_failed");
    } finally {
      if (version.current === currentVersion) setLoading(false);
    }
  }, [workspaceSlug, queryString]);

  useEffect(() => {
    void load();
    return () => {
      version.current += 1;
    };
  }, [load]);

  useEffect(() => {
    void research.fetchOrgUnits(workspaceSlug).catch(() => undefined);
  }, [research, workspaceSlug]);

  return (
    <ResearchListSurface>
      <ResearchBrowseHeader title="课题" />
      <ResearchBrowseToolbar>
        <ResearchBrowseFilters workspaceSlug={workspaceSlug} query={query} kind="projects" appearance="list" />
        <ListFilterField label="课题组">
          <ListFilterSelect
            aria-label="课题组"
            value={query.get("org_unit")}
            onChange={(event) => query.set("org_unit", event.target.value)}
          >
            <option value="">全部课题组</option>
            {research.getOrgUnits(workspaceSlug).map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </ListFilterSelect>
        </ListFilterField>
        <ListFilterField label="状态">
          <ListFilterSelect
            aria-label="研究链状态"
            value={query.get("status")}
            onChange={(event) => query.set("status", event.target.value)}
          >
            <option value="">全部状态</option>
            <option value="ACTIVE">进行中</option>
            <option value="ARCHIVED">已归档</option>
          </ListFilterSelect>
        </ListFilterField>
        <ListFilterField label="类型">
          <ListFilterSelect
            aria-label="项目类型"
            value={query.get("research_type")}
            onChange={(event) => query.set("research_type", event.target.value)}
          >
            <option value="">全部类型</option>
            <option value="RESEARCH_PROJECT">科研项目</option>
            <option value="MASTER">硕士</option>
            <option value="PHD">博士</option>
          </ListFilterSelect>
        </ListFilterField>
        <ResearchBrowseRefresh onRefresh={() => void load()} disabled={loading} />
      </ResearchBrowseToolbar>
      {loading && <p role="status">加载中</p>}
      {forbidden ? (
        <ResearchListState kind="forbidden" resource="reports" />
      ) : error ? (
        <ResearchListState kind="error" resource="reports" onRetry={() => void load()} />
      ) : !loading && !chains.length ? (
        <ResearchListState kind={queryString ? "no-results" : "empty"} resource="reports" />
      ) : null}
      <ResearchTableSurface>
        <Table className="min-w-240">
          <caption className="sr-only">{t("research.nav.research_chain")}</caption>
          <TableHeader>
            <TableRow>
              <TableHead>{t("research.chains.project")}</TableHead>
              <TableHead>{t("research.chains.status")}</TableHead>
              <TableHead>{t("research.chains.current_node")}</TableHead>
              <TableHead className="text-right">{t("research.chains.open_tasks")}</TableHead>
              <TableHead>{t("research.chains.next_due_at")}</TableHead>
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
                <TableCell>
                  {chain.current_node ? (
                    <div className="min-w-0">
                      <p className="truncate text-13 text-secondary">{chain.current_node.title}</p>
                      <ResearchStatusBadge status={chain.current_node.status} size="sm">
                        {t(`research.chains.node_status.${chain.current_node.status.toLowerCase()}`)}
                      </ResearchStatusBadge>
                    </div>
                  ) : (
                    <span className="text-tertiary">-</span>
                  )}
                </TableCell>
                <TableCell className="text-right text-secondary tabular-nums">
                  {t("research.chains.open_task_count", { count: chain.open_task_count ?? 0 })}
                </TableCell>
                <TableCell>
                  {chain.next_due_at ? (
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="text-tertiary tabular-nums">
                        {formatResearchDate(chain.next_due_at, currentLocale)}
                      </span>
                      <ResearchTodoUrgency dueAt={chain.next_due_at} />
                    </div>
                  ) : (
                    <span className="text-tertiary">-</span>
                  )}
                </TableCell>
                <TableCell className="text-secondary">
                  {t(`research.projects.chain_visibility.${chain.visibility.toLowerCase()}`)}
                </TableCell>
                <TableCell className="text-secondary">{chain.owner_name ?? chain.owner}</TableCell>
                <TableCell className="text-right text-tertiary tabular-nums">
                  {formatResearchDateTime(chain.updated_at, currentLocale)}
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
      </ResearchTableSurface>
      <div className="flex shrink-0 justify-end gap-2">
        <Button
          variant="secondary"
          size="xl"
          disabled={!page?.prev_page_results || loading}
          onClick={() => query.set("cursor", page?.prev_cursor ?? "")}
        >
          上一页
        </Button>
        <Button
          variant="secondary"
          size="xl"
          disabled={!page?.next_page_results || loading}
          onClick={() => query.set("cursor", page?.next_cursor ?? "")}
        >
          下一页
        </Button>
      </div>
    </ResearchListSurface>
  );
};
