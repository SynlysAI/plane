// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ todos: vi.fn() }));
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@plane/propel/button", () => ({ Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} /> }));
vi.mock("@/components/research/common/research-todo-urgency", () => ({ ResearchTodoUrgency: () => <span>逾期</span> }));
vi.mock("@/services/project-domains.service", () => ({ ProjectDomainsService: class { todos = mocks.todos; }, domainError: () => "请求失败" }));
const { WorkspaceTodos } = await import("@/components/home/workspace-todos");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement; let root: ReturnType<typeof createRoot>;
const page = (title: string, domain = "ADMINISTRATIVE", next: string | null = null) => ({ results: [{ id: title, title, domain, context: "项目", source: "WORK_ITEM", due_at: "2020-01-01", href: `/${title}` }], next_cursor: next, total_count: 2, degraded_sources: [] });
beforeEach(() => { container = document.createElement("div"); root = createRoot(container); mocks.todos.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); });
it("shows both domains without filtering old unfinished tasks", async () => {
  mocks.todos.mockResolvedValue({ ...page("采购"), results: [...page("采购").results, ...page("科研评审", "RESEARCH").results], degraded_sources: ["RESEARCH:REPORT"] });
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  expect(container.querySelector('a[href="/采购"]')).not.toBeNull();
  expect(container.querySelector('a[href="/科研评审"]')).not.toBeNull();
  expect(container.textContent).toContain("部分待办暂未加载");
});
it("paginates within one selected domain", async () => {
  mocks.todos.mockResolvedValueOnce(page("first", "ADMINISTRATIVE", "next"));
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  mocks.todos.mockResolvedValueOnce(page("second"));
  await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "加载更多")?.click());
  expect(mocks.todos).toHaveBeenLastCalledWith("lab", "all", "next");
  expect(container.querySelectorAll("li")).toHaveLength(2);
});
it("ignores a late response from the previous workspace", async () => {
  let resolve!: (value: unknown) => void;
  mocks.todos.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="first" />));
  mocks.todos.mockResolvedValueOnce(page("current"));
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="second" />));
  await act(async () => resolve(page("stale")));
  expect(container.textContent).toContain("current"); expect(container.textContent).not.toContain("stale");
});
