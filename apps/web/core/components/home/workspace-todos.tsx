import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { ProjectDomainsService, domainError, type TWorkspaceTodoPage } from "@/services/project-domains.service";
import { ResearchTodoUrgency } from "@/components/research/common/research-todo-urgency";
import {
  ResearchChainStageApprovalQueue,
  type TChainStageApprovalQueueItem,
} from "@/components/research/approvals/research-chain-stage-approval-queue";
import { subscribeWorkspaceTodosUpdated } from "@/helpers/workspace-todos.helper";

const service = new ProjectDomainsService();
const CHAIN_STAGE_SOURCE = "CHAIN_STAGE_APPROVAL";
const domains = [
  { value: "all", labelKey: "research.todo.domain_all" },
  { value: "research", labelKey: "research.todo.domain_research" },
  { value: "administrative", labelKey: "research.todo.domain_administrative" },
];

/** Build the compact source-person, context, and handling line for one todo. */
function todoMetadata(todo: TWorkspaceTodoPage["results"][number], t: (key: string) => string) {
  const requesterLabel = todo.source === "REPORT" ? t("research.todo.requester_report") : t("research.todo.requester");
  const handlingLabel =
    todo.source === "APPROVAL"
      ? t("research.todo.handling_approve")
      : todo.source === "WORK_ITEM"
        ? t("research.todo.handling_assign")
        : t("research.todo.handling_process");
  return [todo.requester ? `${requesterLabel}：${todo.requester.display_name}` : null, todo.context, handlingLabel]
    .filter(Boolean)
    .join(" · ");
}

export function WorkspaceTodos({ workspaceSlug, embedded = false }: { workspaceSlug: string; embedded?: boolean }) {
  const { t } = useTranslation();
  const [domain, setDomain] = useState("all");
  const [page, setPage] = useState<TWorkspaceTodoPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [handledIds, setHandledIds] = useState<Set<string>>(() => new Set());
  const [activeQueueId, setActiveQueueId] = useState<string | null>(null);
  const [queueItems, setQueueItems] = useState<TChainStageApprovalQueueItem[]>([]);
  const [queueCompleted, setQueueCompleted] = useState(false);
  const version = useRef(0);
  const load = useCallback(
    async (cursor?: string, options?: { silent?: boolean }) => {
      const request = ++version.current;
      if (!options?.silent) setLoading(true);
      setError(null);
      try {
        const result = await service.todos(workspaceSlug, domain, cursor);
        if (request !== version.current) return;
        setPage((previous) =>
          cursor && previous ? { ...result, results: [...previous.results, ...result.results] } : result
        );
      } catch (cause) {
        if (request === version.current) setError(domainError(cause));
      } finally {
        if (request === version.current) setLoading(false);
      }
    },
    [workspaceSlug, domain]
  );
  useEffect(() => {
    const requestVersion = version;
    setPage(null);
    void load();
    return () => {
      requestVersion.current++;
    };
  }, [load]);
  useEffect(() => {
    return subscribeWorkspaceTodosUpdated(() => void load(undefined, { silent: true }));
  }, [load]);
  useEffect(() => {
    setActiveQueueId(null);
    setQueueItems([]);
    setQueueCompleted(false);
  }, [domain]);

  const visibleResults = page?.results.filter((todo) => !handledIds.has(todo.id)) ?? [];
  const stageQueueItems = visibleResults.filter((todo) => todo.source === CHAIN_STAGE_SOURCE);
  const hiddenInPageCount = page?.results.filter((todo) => handledIds.has(todo.id)).length ?? 0;
  const visibleTotalCount = page ? Math.max(page.total_count - hiddenInPageCount, 0) : 0;

  /** 打开阶段审批侧栏，并保留原深链给辅助技术和新窗口打开。 */
  const openStageQueue = (event: React.MouseEvent<HTMLAnchorElement>, todo: TWorkspaceTodoPage["results"][number]) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    setQueueCompleted(false);
    setQueueItems(stageQueueItems);
    setActiveQueueId(todo.id);
  };

  /** 标记已处理事项并按当前列表顺序打开下一条阶段审批。 */
  const handleStageQueueHandled = (id: string) => {
    const currentIndex = queueItems.findIndex((todo) => todo.id === id);
    const next = currentIndex >= 0 ? queueItems[currentIndex + 1] : undefined;
    setHandledIds((previous) => new Set(previous).add(id));
    setActiveQueueId(next?.id ?? null);
    setQueueCompleted(!next);
  };

  return (
    <>
      {activeQueueId && (
        <ResearchChainStageApprovalQueue
          workspaceSlug={workspaceSlug}
          items={queueItems}
          activeId={activeQueueId}
          onHandled={handleStageQueueHandled}
          onClose={() => {
            setActiveQueueId(null);
            setQueueItems([]);
          }}
        />
      )}
      <section className="flex min-h-0 flex-col" aria-label={t("research.todo.home_title")}>
        <div className="sticky top-0 flex shrink-0 items-center gap-2 border-b border-subtle bg-surface-1 px-4 py-2">
          {domains.map((item) => (
            <button
              type="button"
              key={item.value}
              aria-pressed={domain === item.value}
              className={`rounded px-2 py-1 text-13 ${domain === item.value ? "bg-surface-2 text-primary" : "text-secondary"}`}
              onClick={() => setDomain(item.value)}
            >
              {t(item.labelKey)}
            </button>
          ))}
          <Button className="ml-auto" variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
            {t("research.todo.refresh")}
          </Button>
        </div>
        {queueCompleted && !activeQueueId && (
          <p role="status" className="border-b border-subtle px-4 py-2 text-12 text-secondary">
            {t("research.todo.queue_completed")}
          </p>
        )}
        {error && (
          <p role="alert" className="p-4 text-13">
            {error}
            <button type="button" onClick={() => void load()} className="ml-2 text-accent-primary">
              {t("common.retry")}
            </button>
          </p>
        )}
        {page?.degraded_sources.length ? (
          <p role="status" className="px-4 py-2 text-12 text-secondary">
            {t("research.todo.degraded")}
          </p>
        ) : null}
        {loading && !page && (
          <p role="status" aria-busy="true" className="p-4 text-13 text-secondary">
            {t("research.todo.loading")}
          </p>
        )}
        {!loading && !error && visibleResults.length === 0 && !queueCompleted && (
          <p className="p-4 text-13 text-secondary">{t("research.todo.empty_to_me")}</p>
        )}
        <ul className="divide-y divide-subtle">
          {visibleResults.map((todo) => {
            const isStageApproval = todo.source === CHAIN_STAGE_SOURCE;
            const isActive = todo.id === activeQueueId;
            return (
              <li
                key={todo.id}
                className={`px-4 py-3 hover:bg-surface-2 ${
                  isActive ? "border-accent-primary border-l-2 bg-surface-2" : "border-l-2 border-transparent"
                }`}
              >
                <Link
                  href={todo.href}
                  data-peek-trigger={isStageApproval ? "" : undefined}
                  aria-current={isActive ? "true" : undefined}
                  className="flex items-start gap-2 text-13"
                  onClick={(event) => {
                    if (isStageApproval) openStageQueue(event, todo);
                  }}
                >
                  <span className="shrink-0 rounded bg-surface-2 px-1.5 text-11 text-secondary">
                    {todo.domain === "RESEARCH"
                      ? t("research.todo.domain_research")
                      : t("research.todo.domain_administrative")}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-primary">{todo.title}</span>
                    <span className="mt-1 block text-12 text-secondary">{todoMetadata(todo, t)}</span>
                  </span>
                  {todo.due_at && <ResearchTodoUrgency dueAt={todo.due_at} />}
                </Link>
              </li>
            );
          })}
        </ul>
        {page?.next_cursor && (
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load(page.next_cursor ?? undefined)}>
            {t("common.load_more")}
          </Button>
        )}
        {!embedded && page && (
          <p className="px-4 py-2 text-12 text-tertiary">
            {t("research.todo.total_count", { count: visibleTotalCount })}
          </p>
        )}
      </section>
    </>
  );
}
