import type { TApprovalRequest, TPeriodicReport, TResearchChain, TToMeReview } from "@plane/types";
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

export type TResearchTodoKind = "blocking" | "confirmation" | "reminder" | "syncing";
export type TResearchTodoSource = "report" | "review" | "office" | "upload" | "manual" | "agent";

export type TResearchTodo = {
  id: string;
  source: TResearchTodoSource;
  kind: TResearchTodoKind;
  title: string;
  context: string;
  href: string;
  dueAt: string | null;
  updatedAt: string;
};

export type TResearchTodoAccess = {
  /** Capability check from the research identity store. */
  canSee: (key: string) => boolean;
  /** Whether the research agent section is enabled for the workspace. */
  agentEnabled: boolean;
};

export type TResearchTodoTranslate = (key: string) => string;

const KIND_RANK: Record<TResearchTodoKind, number> = {
  blocking: 0,
  confirmation: 1,
  reminder: 2,
  syncing: 3,
};

/** Convert a timestamp to a stable numeric value even when a backend omits it. */
export function todoTimeValue(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Sort and deduplicate todos by source object, severity, due date and freshness.
 *
 * Args:
 *   todos: Todos collected from every source system.
 *
 * Returns:
 *   Deduplicated todos ordered by severity, due date and recency.
 */
export function normalizeResearchTodos(todos: TResearchTodo[]) {
  const byObject = new Map<string, TResearchTodo>();
  for (const todo of todos) {
    const existing = byObject.get(todo.id);
    if (
      !existing ||
      KIND_RANK[todo.kind] < KIND_RANK[existing.kind] ||
      (KIND_RANK[todo.kind] === KIND_RANK[existing.kind] &&
        todoTimeValue(todo.updatedAt) > todoTimeValue(existing.updatedAt))
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
    return todoTimeValue(right.updatedAt) - todoTimeValue(left.updatedAt);
  });
}

/** Build a compact RAG upload todo while translating lifecycle status to severity. */
function uploadTodo(workspaceSlug: string, chainId: string, upload: TResearchChainUpload): TResearchTodo {
  const kind: TResearchTodoKind =
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

/**
 * Collect cross-component research todos from every source system.
 *
 * Args:
 *   options: Workspace slug, visibility access, translator, optional period and
 *     chains already loaded by the caller to avoid a duplicate request.
 *
 * Returns:
 *   Normalized, deduplicated todos shared by the index and the home summary.
 */
export async function collectResearchTodos({
  workspaceSlug,
  access,
  translate,
  periodDays = null,
  preloadedChains = null,
}: {
  workspaceSlug: string;
  access: TResearchTodoAccess;
  translate: TResearchTodoTranslate;
  periodDays?: number | null;
  preloadedChains?: TResearchChain[] | null;
}): Promise<TResearchTodo[]> {
  const collected: TResearchTodo[] = [];
  const periodStart = periodDays ? new Date(Date.now() - periodDays * 86400000).toISOString() : null;
  const withinPeriod = (value: string | null | undefined) =>
    !periodStart || todoTimeValue(value) >= new Date(periodStart).getTime();

  const tasks: Array<Promise<void>> = [];
  if (access.canSee("reports")) {
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
  if (access.canSee("reviews")) {
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
  if (access.canSee("approvals")) {
    tasks.push(
      (async () => {
        const payload = await approvalService.getApprovalRequests(workspaceSlug, { scope: "to_me" }).catch(() => null);
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
  if (access.agentEnabled && access.canSee("research_chain")) {
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
  if (access.canSee("research_chain")) {
    tasks.push(
      (async () => {
        const chains = preloadedChains ?? (await chainService.getChains(workspaceSlug).catch(() => []));
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
  return normalizeResearchTodos(collected);
}
