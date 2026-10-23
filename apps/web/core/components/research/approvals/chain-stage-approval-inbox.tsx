/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";

import { useTranslation } from "@plane/i18n";
import type { TResearchTodoEnvelope } from "@plane/types";
import { TabNavigationItem, TabNavigationList } from "@plane/propel/tab-navigation";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";

import { formatResearchDateTime } from "@/components/research/common/research-format";
import { ResearchBrowseRefresh } from "@/components/research/common/research-browse-toolbar";
import { ResearchTodoService } from "@/services/research/research-todo.service";

type Props = {
  workspaceSlug: string;
};

const SCOPES = ["to_me", "visible"] as const;

const todoService = new ResearchTodoService();

/** 读取审批待办的当前审核步骤。 */
function stepLabelKey(item: TResearchTodoEnvelope): string {
  if (item.business_status === "AWAITING_ADVISOR") return "research.approvals.stage_step_advisor";
  if (item.business_status === "AWAITING_PI") return "research.approvals.stage_step_pi";
  return item.context;
}

/** 读取审批待办相对于当前用户的可读状态。 */
function statusLabelKey(item: TResearchTodoEnvelope): string {
  if (item.assignees.length === 0) return "research.approvals.stage_status_blocked";
  return item.capabilities?.actions.approve?.allowed
    ? "research.approvals.stage_status_waiting_me"
    : "research.approvals.stage_status_waiting_others";
}

/** 为审批中心直达链接追加自动展开参数。 */
function approvalHref(href: string): string {
  if (href.includes("approval=1")) return href;
  return href.includes("?") ? `${href}&approval=1` : `${href}?approval=1`;
}

/** 科研链十三阶段审批收件箱。 */
export function ChainStageApprovalInbox({ workspaceSlug }: Props) {
  const { t, currentLocale } = useTranslation();
  const [scope, setScope] = useState<(typeof SCOPES)[number]>("to_me");
  const [items, setItems] = useState<TResearchTodoEnvelope[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      const payload = await todoService.getResearchTodos(workspaceSlug, { scope, limit: 100 });
      setItems(payload.results.filter((item) => item.source === "CHAIN_STAGE_APPROVAL"));
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [scope, workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="flex h-full flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle px-5 py-3">
        <TabNavigationList>
          {SCOPES.map((item) => (
            <button key={item} type="button" onClick={() => setScope(item)}>
              <TabNavigationItem isActive={item === scope}>
                {t(`research.approvals.${item === "to_me" ? "to_me" : "all_visible"}`)}
              </TabNavigationItem>
            </button>
          ))}
        </TabNavigationList>
        <ResearchBrowseRefresh disabled={loading} onRefresh={() => void load()} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {loading ? (
          <p className="text-12 text-tertiary">{t("research.common.loading")}</p>
        ) : failed ? (
          <div className="rounded-lg border border-dashed border-subtle p-6 text-center" role="alert">
            <p className="text-13 font-medium text-primary">{t("research.status.load_failed.title")}</p>
            <p className="mt-1 text-12 text-tertiary">{t("research.approvals.stage_queue_load_failed")}</p>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-subtle p-6 text-center" role="status">
            <p className="text-13 font-medium text-primary">{t("research.approvals.stage_queue_empty")}</p>
            <p className="mt-1 text-12 text-tertiary">{t("research.approvals.stage_queue_empty_description")}</p>
          </div>
        ) : (
          <div className="rounded-lg border border-subtle bg-surface-1">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("research.approvals.stage_queue_topic")}</TableHead>
                  <TableHead>{t("research.approvals.stage_queue_step")}</TableHead>
                  <TableHead>{t("research.approvals.stage_queue_status")}</TableHead>
                  <TableHead>{t("research.approvals.stage_queue_requester")}</TableHead>
                  <TableHead>{t("research.approvals.stage_queue_updated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Link
                        to={approvalHref(item.href)}
                        className="text-13 font-medium text-primary hover:text-accent-primary"
                      >
                        {item.title}
                      </Link>
                    </TableCell>
                    <TableCell className="text-12 text-secondary">{t(stepLabelKey(item))}</TableCell>
                    <TableCell className="text-12 text-secondary">{t(statusLabelKey(item))}</TableCell>
                    <TableCell className="text-12 text-secondary">{item.requester?.display_name ?? "-"}</TableCell>
                    <TableCell className="text-12 text-tertiary">
                      {formatResearchDateTime(item.updated_at, currentLocale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </section>
  );
}
