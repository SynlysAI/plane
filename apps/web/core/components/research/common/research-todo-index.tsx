"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "react-router";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Skeleton } from "@plane/propel/skeleton";
import type {
  TResearchTodoEnvelope,
  TResearchTodoHandlingStatus,
  TResearchTodoNextAction,
  TResearchTodoScope,
  TResearchTodoSource,
} from "@plane/types";
// components
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { formatResearchDate } from "@/components/research/common/research-format";
import { ResearchTodoUrgency } from "@/components/research/common/research-todo-urgency";
// services
import { ResearchTodoService } from "@/services/research/research-todo.service";

const todoService = new ResearchTodoService();
const TODO_REQUEST_LIMIT = 100;
const TODO_SCOPES = ["to_me", "mine", "visible"] as const;
const TODO_SCOPE_PARAM = "todo_scope";

const SOURCE_LABEL_KEYS: Record<TResearchTodoSource, string> = {
  CHAIN_TASK: "research.todo.source_chain_task",
  REPORT: "research.todo.source_report_v2",
  PAPER_REVIEW: "research.todo.source_paper_review",
  STAGE_REVIEW: "research.todo.source_stage_review",
  AGENT_APPROVAL: "research.todo.source_agent",
  OFFICE_APPROVAL: "research.todo.source_office",
};

const HANDLING_LABEL_KEYS: Record<TResearchTodoHandlingStatus, string> = {
  TODO: "research.todo.handling_todo",
  IN_PROGRESS: "research.todo.handling_in_progress",
  RETURNED: "research.todo.handling_returned",
  DONE: "research.todo.handling_done",
  BLOCKED: "research.todo.handling_blocked",
};

const NEXT_ACTION_LABEL_KEYS: Record<TResearchTodoNextAction, string> = {
  READ: "research.todo.next_read",
  REVIEW: "research.todo.next_review",
  SUBMIT: "research.todo.next_submit",
  RETURN: "research.todo.next_return",
  ACCEPT: "research.todo.next_accept",
  WITHDRAW: "research.todo.next_withdraw",
  COMPLETE: "research.todo.next_complete",
  CANCEL: "research.todo.next_cancel",
  APPROVE: "research.todo.next_approve",
  REJECT: "research.todo.next_reject",
};

const BUSINESS_STATUS_LABEL_KEYS: Record<string, string> = {
  ASSIGNED: "research.todo.business_assigned",
  SUBMITTED: "research.todo.business_submitted",
  NEEDS_REVISION: "research.todo.business_needs_revision",
  WAITING_REVIEW: "research.todo.business_waiting_review",
  WAITING_APPROVAL: "research.todo.business_waiting_approval",
  FAILED: "research.todo.business_failed",
};

const SCOPE_LABEL_KEYS: Record<TResearchTodoScope, string> = {
  to_me: "research.todo.scope_to_me",
  mine: "research.todo.scope_mine",
  visible: "research.todo.scope_visible",
};

const EMPTY_LABEL_KEYS: Record<TResearchTodoScope, string> = {
  to_me: "research.todo.empty_to_me",
  mine: "research.todo.empty_mine",
  visible: "research.todo.empty_visible",
};

type TodoErrorKind = "permission" | "conflict" | "unavailable";

type TodoRequestError = {
  status?: number;
};

type Props = {
  workspaceSlug: string;
  scope?: TResearchTodoScope;
  limit?: number;
  periodDays?: number | null;
};

/** Check whether a server todo belongs to the selected overview period. */
function withinPeriod(todo: TResearchTodoEnvelope, periodDays: number | null, now: number) {
  if (!periodDays) return true;
  const updatedAt = new Date(todo.updated_at).getTime();
  return !Number.isNaN(updatedAt) && updatedAt >= now - periodDays * 86400000;
}

/** Build the compact participant and original-status line for one todo row. */
function todoMetadata(todo: TResearchTodoEnvelope, translate: (key: string) => string) {
  const requester = todo.requester?.display_name;
  const assignees = todo.assignees
    .map((assignee) => assignee.display_name)
    .filter(Boolean)
    .join("、");
  const businessStatus = translate(
    BUSINESS_STATUS_LABEL_KEYS[todo.business_status] ?? "research.todo.business_unknown"
  );
  return [
    todo.context || translate(SOURCE_LABEL_KEYS[todo.source]),
    requester ? `${translate("research.todo.requester")}：${requester}` : null,
    assignees ? `${translate("research.todo.assignees")}：${assignees}` : null,
    `${translate("research.todo.business_status")}：${businessStatus}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** 归一化 URL 中的待办范围，并在缺失或非法时使用调用方默认值。 */
function normalizeTodoScope(value: string | null, fallback: TResearchTodoScope): TResearchTodoScope {
  return TODO_SCOPES.find((scope) => scope === value) ?? fallback;
}

/** 将聚合请求失败映射为安全、可恢复的界面提示类型。 */
function todoErrorKind(error: TodoRequestError | null): TodoErrorKind {
  if (error?.status === 401 || error?.status === 403) return "permission";
  if (error?.status === 409) return "conflict";
  return "unavailable";
}

/** 构造降级来源提示，不暴露 Trace 或异常细节。 */
function degradedSourceMessage(sources: TResearchTodoSource[], translate: (key: string) => string) {
  const labels = sources.map((source) => translate(SOURCE_LABEL_KEYS[source])).join("、");
  return `${translate("research.todo.degraded")}：${labels}`;
}

/** Render the server-authoritative research todo projection without local state transitions. */
export function ResearchTodoEnvelopeList({ workspaceSlug, scope = "to_me", limit = 5, periodDays = null }: Props) {
  const { t, currentLocale } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeScope = normalizeTodoScope(searchParams.get(TODO_SCOPE_PARAM), scope);
  const [todos, setTodos] = useState<TResearchTodoEnvelope[]>([]);
  const [degradedSources, setDegradedSources] = useState<TResearchTodoSource[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [errorKind, setErrorKind] = useState<TodoErrorKind | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const payload = await todoService.getResearchTodos(workspaceSlug, {
        scope: activeScope,
        limit: TODO_REQUEST_LIMIT,
      });
      const normalized = payload.results.filter((todo) => withinPeriod(todo, periodDays, Date.now()));
      setTodos(normalized);
      setDegradedSources(payload.degraded_sources);
      setPage(0);
      setErrorKind(null);
      setState(normalized.length ? "ready" : "empty");
    } catch (error) {
      setTodos([]);
      setDegradedSources([]);
      setErrorKind(todoErrorKind(error as TodoRequestError));
      setState("error");
    }
  }, [activeScope, periodDays, workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const pageCount = Math.max(1, Math.ceil(todos.length / limit));
  const pagedTodos = useMemo(() => todos.slice(page * limit, (page + 1) * limit), [limit, page, todos]);

  const changeScope = useCallback(
    (nextScope: TResearchTodoScope) => {
      if (nextScope === activeScope) return;
      const params = new URLSearchParams(searchParams);
      params.set(TODO_SCOPE_PARAM, nextScope);
      setSearchParams(params);
    },
    [activeScope, searchParams, setSearchParams]
  );

  return (
    <section className="min-w-0 overflow-hidden rounded-xl bg-surface-2" aria-label={t("research.todo.title")}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <h3 className="text-13 font-semibold text-primary">{t("research.todo.title")}</h3>
          <p className="mt-0.5 text-11 text-tertiary">{t("research.todo.description_v2")}</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div
            className="flex min-w-0 flex-wrap items-center gap-1"
            role="group"
            aria-label={t("research.todo.scope_label")}
          >
            {TODO_SCOPES.map((scopeOption) => (
              <Button
                key={scopeOption}
                variant="secondary"
                size="sm"
                aria-pressed={scopeOption === activeScope}
                onClick={() => changeScope(scopeOption)}
              >
                {t(SCOPE_LABEL_KEYS[scopeOption])}
              </Button>
            ))}
          </div>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            {t("research.todo.refresh")}
          </Button>
          {todos.length > limit && (
            <div className="flex items-center gap-1" aria-label={t("research.todo.pagination")}>
              <Button
                variant="secondary"
                size="sm"
                aria-label={t("research.todo.previous_page")}
                disabled={page === 0}
                onClick={() => setPage((value) => Math.max(0, value - 1))}
              >
                ‹
              </Button>
              <span className="text-11 tabular-nums" aria-live="polite">
                {page + 1}/{pageCount}
              </span>
              <Button
                variant="secondary"
                size="sm"
                aria-label={t("research.todo.next_page")}
                disabled={page >= pageCount - 1}
                onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
              >
                ›
              </Button>
            </div>
          )}
        </div>
      </div>
      {state === "loading" && (
        <div className="space-y-2 p-4" role="status" aria-busy="true">
          {[0, 1, 2].map((row) => (
            <Skeleton.Item key={row} height="44px" width="100%" />
          ))}
        </div>
      )}
      {state === "error" && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-4" role="alert">
          <p className="min-w-0 text-12 text-secondary">
            {t(
              errorKind === "permission"
                ? "research.todo.error_permission"
                : errorKind === "conflict"
                  ? "research.todo.error_conflict"
                  : "research.todo.error_unavailable"
            )}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            {t("research.status.retry")}
          </Button>
        </div>
      )}
      {state === "empty" && (
        <>
          <p className="p-4 text-12 text-secondary">{t(EMPTY_LABEL_KEYS[activeScope])}</p>
          {degradedSources.length > 0 && (
            <p className="border-t border-subtle px-4 py-2 text-11 text-tertiary" role="status">
              {degradedSourceMessage(degradedSources, t)}
            </p>
          )}
        </>
      )}
      {state === "ready" && (
        <>
          {degradedSources.length > 0 && (
            <p className="border-t border-subtle px-4 py-2 text-11 text-tertiary" role="status">
              {degradedSourceMessage(degradedSources, t)}
            </p>
          )}
          <ul className="divide-y divide-subtle" role="list">
            {pagedTodos.map((todo) => (
              <li key={todo.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <ResearchStatusBadge status={todo.source} size="sm">
                      {t(SOURCE_LABEL_KEYS[todo.source])}
                    </ResearchStatusBadge>
                    <ResearchStatusBadge status={todo.handling_status} size="sm">
                      {t(HANDLING_LABEL_KEYS[todo.handling_status])}
                    </ResearchStatusBadge>
                    <p className="truncate text-12 font-medium text-primary">{todo.title}</p>
                  </div>
                  <p className="mt-1 truncate text-11 text-tertiary">{todoMetadata(todo, t)}</p>
                  {todo.due_at && (
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-11 text-tertiary">
                      <span>
                        {t("research.todo.due_at")}：{formatResearchDate(todo.due_at, currentLocale)}
                      </span>
                      <ResearchTodoUrgency dueAt={todo.due_at} urgency={todo.urgency} />
                    </p>
                  )}
                </div>
                <Link href={todo.href} className="text-12 text-accent-primary transition-colors hover:underline">
                  {t(NEXT_ACTION_LABEL_KEYS[todo.next_action])}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
