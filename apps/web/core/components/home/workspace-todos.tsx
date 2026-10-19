import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@plane/propel/button";
import { ProjectDomainsService, domainError, type TWorkspaceTodoPage } from "@/services/project-domains.service";
import { ResearchTodoUrgency } from "@/components/research/common/research-todo-urgency";

const service = new ProjectDomainsService();
const domains = [{ value: "all", label: "全部" }, { value: "research", label: "科研" }, { value: "administrative", label: "行政" }];
export function WorkspaceTodos({ workspaceSlug, embedded = false }: { workspaceSlug: string; embedded?: boolean }) {
  const [domain, setDomain] = useState("all");
  const [page, setPage] = useState<TWorkspaceTodoPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const version = useRef(0);
  const load = useCallback(async (cursor?: string) => {
    const request = ++version.current;
    setLoading(true); setError(null);
    try {
      const result = await service.todos(workspaceSlug, domain, cursor);
      if (request !== version.current) return;
      setPage((previous) => cursor && previous ? { ...result, results: [...previous.results, ...result.results] } : result);
    } catch (cause) { if (request === version.current) setError(domainError(cause)); }
    finally { if (request === version.current) setLoading(false); }
  }, [workspaceSlug, domain]);
  useEffect(() => { setPage(null); void load(); return () => { version.current++; }; }, [load]);
  useEffect(() => { const refresh = () => void load(); window.addEventListener("workspace-todos-updated", refresh); return () => window.removeEventListener("workspace-todos-updated", refresh); }, [load]);
  return <section className="flex min-h-0 flex-col" aria-label="我的待办">
    <div className="sticky top-0 flex shrink-0 items-center gap-2 border-b border-subtle bg-surface-1 px-4 py-2">
      {domains.map((item) => <button type="button" key={item.value} aria-pressed={domain === item.value}
        className={`rounded px-2 py-1 text-13 ${domain === item.value ? "bg-surface-2 text-primary" : "text-secondary"}`}
        onClick={() => setDomain(item.value)}>{item.label}</button>)}
      <Button className="ml-auto" variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>刷新</Button>
    </div>
    {error && <p role="alert" className="p-4 text-13">{error}<button type="button" onClick={() => void load()} className="ml-2 text-accent-primary">重试</button></p>}
    {page?.degraded_sources.length ? <p role="status" className="px-4 py-2 text-12 text-secondary">部分待办暂未加载，请稍后刷新；其他待办仍可处理。</p> : null}
    {loading && !page && <p role="status" aria-busy="true" className="p-4 text-13 text-secondary">正在加载待办…</p>}
    {!loading && !error && page?.results.length === 0 && <p className="p-4 text-13 text-secondary">当前没有待处理事项。</p>}
    <ul className="divide-y divide-subtle">
      {page?.results.map((todo) => <li key={todo.id} className="px-4 py-3 hover:bg-surface-2">
        <Link href={todo.href} className="flex items-start gap-2 text-13">
          <span className="shrink-0 rounded bg-surface-2 px-1.5 text-11 text-secondary">{todo.domain === "RESEARCH" ? "科研" : "行政"}</span>
          <span className="min-w-0 flex-1"><span className="font-medium text-primary">{todo.title}</span>
            <span className="mt-1 block text-12 text-secondary">{todo.context} · {todo.source === "APPROVAL" ? "待我审批" : todo.source === "WORK_ITEM" ? "指派给我" : "待我处理"}</span></span>
          {todo.due_at && <ResearchTodoUrgency dueAt={todo.due_at} />}
        </Link>
      </li>)}
    </ul>
    {page?.next_cursor && <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load(page.next_cursor ?? undefined)}>加载更多</Button>}
    {!embedded && page && <p className="px-4 py-2 text-12 text-tertiary">共 {page.total_count} 项待办</p>}
  </section>;
}
