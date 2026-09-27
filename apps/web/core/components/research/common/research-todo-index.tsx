"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Skeleton } from "@plane/propel/skeleton";
// components
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { formatResearchDate } from "@/components/research/common/research-format";
import { collectResearchTodos, type TResearchTodo } from "@/components/research/common/research-todo-source";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
  limit?: number;
  periodDays?: number | null;
};

/** Cross-component to-do index assembled from each source system without local completion. */
export function ResearchTodoIndex({ workspaceSlug, limit = 5, periodDays = null }: Props) {
  const { t, currentLocale } = useTranslation();
  const research = useResearch();
  const translateRef = useRef(t);
  const [todos, setTodos] = useState<TResearchTodo[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [page, setPage] = useState(0);
  const translate = translateRef.current;

  const load = useCallback(async () => {
    setState("loading");
    try {
      const normalized = await collectResearchTodos({
        workspaceSlug,
        access: {
          canSee: research.canSee.bind(research),
          agentEnabled: Boolean(research.identity?.sections?.research_agent),
        },
        translate,
        periodDays,
      });
      setTodos(normalized);
      setPage(0);
      setState(normalized.length ? "ready" : "empty");
    } catch {
      setTodos([]);
      setState("error");
    }
  }, [periodDays, research, translate, workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const pageCount = Math.max(1, Math.ceil(todos.length / limit));
  const pagedTodos = useMemo(() => todos.slice(page * limit, (page + 1) * limit), [limit, page, todos]);

  return (
    <section className="overflow-hidden rounded-xl bg-surface-2" aria-label={t("research.todo.title")}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <h3 className="text-13 font-semibold text-primary">{t("research.todo.title")}</h3>
          <p className="mt-0.5 text-11 text-tertiary">{t("research.todo.description")}</p>
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
        <ul className="divide-y divide-subtle" role="list">
          {pagedTodos.map((todo) => (
            <li key={todo.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <ResearchStatusBadge status={todo.kind}>{t(`research.todo.kind_${todo.kind}`)}</ResearchStatusBadge>
                  <p className="truncate text-12 font-medium text-primary">{todo.title}</p>
                </div>
                <p className="mt-1 truncate text-11 text-tertiary">
                  {todo.context || t(`research.todo.source_${todo.source}`)}
                  {todo.dueAt && ` · ${formatResearchDate(todo.dueAt, currentLocale)}`}
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
