"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Skeleton } from "@plane/propel/skeleton";
import type { TApprovalRequest, TPeriodicReport, TToMeReview } from "@plane/types";
// components
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
// hooks
import { useResearch } from "@/hooks/store/use-research";
// services
import { ResearchAgentService } from "@/services/research/agent.service";
import { ResearchApprovalService } from "@/services/research/approval.service";
import { ResearchChainService, type TResearchChainUpload } from "@/services/research/chain.service";
import { ResearchIntegrationService } from "@/services/research/integration.service";
import { ResearchReportService } from "@/services/research/report.service";
import { ResearchReviewService } from "@/services/research/review.service";

const approvalService = new ResearchApprovalService();
const agentService = new ResearchAgentService();
const chainService = new ResearchChainService();
const integrationService = new ResearchIntegrationService();
const reportService = new ResearchReportService();
const reviewService = new ResearchReviewService();

type Props = {
  workspaceSlug: string;
  limit?: number;
  periodDays?: number | null;
  compact?: boolean;
};

type TTodoKind = "blocking" | "confirmation" | "reminder" | "syncing";
type TTodoSource = "report" | "review" | "office" | "upload" | "manual" | "agent";

type TResearchTodo = {
  id: string;
  source: TTodoSource;
  kind: TTodoKind;
  title: string;
  context: string;
  href: string;
  dueAt: string | null;
  updatedAt: string;
};

const KIND_RANK: Record<TTodoKind, number> = {
  blocking: 0,
  confirmation: 1,
  reminder: 2,
  syncing: 3,
};

/** Convert a timestamp to a stable numeric value even when a backend omits it. */
function timeValue(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Sort and deduplicate todos by source object, severity, due date and freshness. */
function normalizeTodos(todos: TResearchTodo[]) {
  const byObject = new Map<string, TResearchTodo>();
  for (const todo of todos) {
    const existing = byObject.get(todo.id);
    if (
      !existing ||
      KIND_RANK[todo.kind] < KIND_RANK[existing.kind] ||
      (KIND_RANK[todo.kind] === KIND_RANK[existing.kind] && timeValue(todo.updatedAt) > timeValue(existing.updatedAt))
    ) {
      byObject.set(todo.id, todo);
    }
  }
  // eslint-disable-next-line unicorn/no-array-sort
  return [...byObject.values()].sort((left, right) => {
    if (KIND_RANK[left.kind] !== KIND_RANK[right.kind]) return KIND_RANK[left.kind] - KIND_RANK[right.kind];
    const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
    if (leftDue !== rightDue) return leftDue - rightDue;
    return timeValue(right.updatedAt) - timeValue(left.updatedAt);
  });
}

/** Build a compact RAG upload todo while translating lifecycle status to severity. */
function uploadTodo(workspaceSlug: string, chainId: string, upload: TResearchChainUpload): TResearchTodo {
  const kind: TTodoKind =
    upload.status === "FAILED" || upload.status === "DEGRADED"
      ? "blocking"
      : upload.status === "PENDING"
        ? "reminder"
        : "syncing";
  return {
    id: `upload:${upload.id}`,
    source: "upload",
    kind,
    title: upload.file_name || "RAGPortal upload",
    context: "",
    href: `/${workspaceSlug}/research/chains/${chainId}`,
    dueAt: null,
    updatedAt: new Date().toISOString(),
  };
}

/** Cross-component to-do index assembled from each source system without local completion. */
export function ResearchTodoIndex({ workspaceSlug, limit = 8, periodDays = null, compact = false }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const translateRef = useRef(t);
  const [todos, setTodos] = useState<TResearchTodo[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const translate = translateRef.current;

  const load = useCallback(async () => {
    setState("loading");
    const collected: TResearchTodo[] = [];
    const periodStart = periodDays ? new Date(Date.now() - periodDays * 86400000).toISOString() : null;
    const withinPeriod = (value: string | null | undefined) =>
      !periodStart || timeValue(value) >= new Date(periodStart).getTime();

    const tasks: Array<Promise<void>> = [];
    if (research.canSee("reports")) {
      tasks.push(
        (async () => {
          const payload = await reportService
            .getReports(workspaceSlug, { status: "NEEDS_REVISION", mine: "true", per_page: "50" })
            .catch(() => null);
          if (payload) {
            for (const report of payload.results as TPeriodicReport[]) {
              if (!withinPeriod(report.updated_at)) continue;
              collected.push({
                id: `report:${report.id}`,
                source: "report",
                kind: "confirmation",
                title: `${translate("research.todo.report_revision")} · ${report.period_key}`,
                context: report.owner_detail?.display_name ?? report.project ?? "",
                href: `/${workspaceSlug}/research/chains?view=reports&status=NEEDS_REVISION&mine=true`,
                dueAt: report.period_end,
                updatedAt: report.updated_at,
              });
            }
          }
        })()
      );
    }
    if (research.canSee("reviews")) {
      tasks.push(
        (async () => {
          const payload = await reviewService.getReviews(workspaceSlug, "to_me").catch(() => null);
          if (payload) {
            for (const review of (payload as { results?: TToMeReview[] }).results ?? []) {
              if (!withinPeriod(review.valid_until) && review.valid_until) continue;
              collected.push({
                id: `review:${review.assignment_id}`,
                source: "review",
                kind: review.is_required ? "confirmation" : "reminder",
                title: `${translate("research.todo.stage_review")} · ${review.project_name}`,
                context: translate(`research.roles.${review.reviewer_role.toLowerCase()}`),
                href: `/${workspaceSlug}/research/projects/${review.project}/stages/${review.stage_id}`,
                dueAt: review.valid_until,
                updatedAt: review.valid_until ?? new Date().toISOString(),
              });
            }
          }
        })()
      );
    }
    if (research.canSee("approvals")) {
      tasks.push(
        (async () => {
          const payload = await approvalService
            .getApprovalRequests(workspaceSlug, { scope: "to_me" })
            .catch(() => null);
          if (payload) {
            for (const request of payload.results as TApprovalRequest[]) {
              if (request.status !== "PENDING" || !withinPeriod(request.created_at)) continue;
              collected.push({
                id: `office:${request.id}`,
                source: "office",
                kind: "confirmation",
                title: request.issue_detail?.name ?? translate("research.todo.office_approval"),
                context: request.requested_by_detail?.display_name ?? request.requested_by ?? "",
                href: `/${workspaceSlug}/research/approvals?tab=office`,
                dueAt: null,
                updatedAt: request.created_at,
              });
            }
          }
        })()
      );
    }
    if (research.identity?.sections?.research_agent && research.canSee("research_chain")) {
      tasks.push(
        (async () => {
          const payload = await agentService.getApprovals(workspaceSlug).catch(() => null);
          if (payload) {
            for (const approval of payload.results) {
              collected.push({
                id: `agent:${approval.session_id}`,
                source: "agent",
                kind: "confirmation",
                title: `${approval.project_name ?? approval.project} · ${approval.chain_node_title ?? approval.chain_node}`,
                context: approval.summary,
                href: `/${workspaceSlug}/research/approvals?tab=agent_approval`,
                dueAt: null,
                updatedAt: approval.updated_at,
              });
            }
          }
        })()
      );
    }
    if (research.canSee("research_chain")) {
      tasks.push(
        (async () => {
          const chains = await chainService.getChains(workspaceSlug).catch(() => []);
          if (chains.length) {
            const nodeGroups = await Promise.all(
              chains.slice(0, 12).map((chain) =>
                chainService
                  .getChainNodes(workspaceSlug, chain.id)
                  .then((nodes) => ({ chain, nodes }))
                  .catch(() => ({ chain, nodes: [] }))
              )
            );
            const uploadGroups = await Promise.all(
              nodeGroups.flatMap(({ chain, nodes }) =>
                nodes.slice(0, 20).map((node) =>
                  chainService
                    .getKnowledgeUploads(workspaceSlug, chain.id, node.id)
                    .then((uploads) => ({ chain, uploads: uploads.data }))
                    .catch(() => ({ chain, uploads: [] as TResearchChainUpload[] }))
                )
              )
            );
            for (const { chain, uploads } of uploadGroups) {
              for (const upload of uploads) {
                if (upload.status !== "SUCCESS") collected.push(uploadTodo(workspaceSlug, chain.id, upload));
              }
            }
          }
        })()
      );
      tasks.push(
        (async () => {
          const payload = await integrationService.getConnections(workspaceSlug).catch(() => null);
          if (payload) {
            const rag = payload.results.find((connection) => connection.system === "RAGPORTAL");
            if (rag && (!rag.is_enabled || rag.health_status === "DEGRADED" || rag.health_status === "DOWN")) {
              collected.push({
                id: "manual:ragportal",
                source: "manual",
                kind: "reminder",
                title: translate("research.todo.manual_backfill"),
                context: translate("research.todo.external_degraded"),
                href: `/${workspaceSlug}/research/settings/integrations`,
                dueAt: null,
                updatedAt: new Date().toISOString(),
              });
            }
          }
        })()
      );
    }

    await Promise.all(tasks);
    const normalized = normalizeTodos(collected);
    setTodos(normalized);
    setState(normalized.length ? "ready" : "empty");
  }, [periodDays, research, translate, workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const visibleTodos = useMemo(() => todos.slice(0, limit), [limit, todos]);

  return (
    <section className="rounded-xl border border-subtle bg-surface-1" aria-label={t("research.todo.title")}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle px-4 py-3">
        <div>
          <h3 className="text-13 font-semibold text-primary">{t("research.todo.title")}</h3>
          <p className="mt-0.5 text-11 text-tertiary">{t("research.todo.description")}</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          {t("research.todo.refresh")}
        </Button>
      </div>
      {state === "loading" && (
        <div className="space-y-2 p-4" role="status" aria-busy="true">
          {[0, 1, 2].map((row) => (
            <Skeleton.Item key={row} height="44px" width="100%" />
          ))}
        </div>
      )}
      {state === "error" && (
        <p className="p-4 text-12 text-secondary" role="alert">
          {t("research.todo.error")}
        </p>
      )}
      {state === "empty" && <p className="p-4 text-12 text-secondary">{t("research.todo.empty")}</p>}
      {state === "ready" && (
        <ul className={compact ? "divide-y divide-subtle" : "divide-y divide-subtle"} role="list">
          {visibleTodos.map((todo) => (
            <li key={todo.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <ResearchStatusBadge status={todo.kind}>{t(`research.todo.kind_${todo.kind}`)}</ResearchStatusBadge>
                  <p className="truncate text-12 font-medium text-primary">{todo.title}</p>
                </div>
                <p className="mt-1 truncate text-11 text-tertiary">
                  {todo.context || t(`research.todo.source_${todo.source}`)}
                  {todo.dueAt && ` · ${new Date(todo.dueAt).toLocaleDateString()}`}
                </p>
              </div>
              <Link href={todo.href} className="text-12 text-accent-primary transition-colors hover:underline">
                {t("research.todo.open")}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
