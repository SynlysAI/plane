// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ todos: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@/components/research/common/research-todo-urgency", () => ({ ResearchTodoUrgency: () => <span>逾期</span> }));
vi.mock("@/services/project-domains.service", () => ({
  ProjectDomainsService: class {
    todos = mocks.todos;
  },
  domainError: () => "请求失败",
}));
const { WorkspaceTodos } = await import("@/components/home/workspace-todos");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const todo = (title = "采购", overrides: Record<string, unknown> = {}) => ({
  id: title,
  title,
  domain: "ADMINISTRATIVE",
  source: "WORK_ITEM",
  context: "项目",
  due_at: "2020-01-01",
  href: `/${title}`,
  requester: null,
  ...overrides,
});
const page = (items: Record<string, unknown>[], next: string | null = null) => ({
  results: items,
  next_cursor: next,
  total_count: items.length,
  degraded_sources: [],
});
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  mocks.todos.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
});
it("shows both domains without filtering old unfinished tasks", async () => {
  mocks.todos.mockResolvedValue({
    ...page([todo(), todo("科研评审", { domain: "RESEARCH" })]),
    degraded_sources: ["RESEARCH:REPORT"],
  });
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  expect(container.querySelector('a[href="/采购"]')).not.toBeNull();
  expect(container.querySelector('a[href="/科研评审"]')).not.toBeNull();
  expect(container.textContent).toContain("部分待办暂未加载");
});
it("paginates within one selected domain", async () => {
  mocks.todos.mockResolvedValueOnce(page([todo("first")], "next"));
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  mocks.todos.mockResolvedValueOnce(page([todo("second")]));
  await act(async () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "加载更多")?.click()
  );
  expect(mocks.todos).toHaveBeenLastCalledWith("lab", "all", "next");
  expect(container.querySelectorAll("li")).toHaveLength(2);
});
it("ignores a late response from the previous workspace", async () => {
  let resolve!: (value: unknown) => void;
  mocks.todos.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="first" />));
  mocks.todos.mockResolvedValueOnce(page([todo("current")]));
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="second" />));
  await act(async () => resolve(page("stale")));
  expect(container.textContent).toContain("current");
  expect(container.textContent).not.toContain("stale");
});

it("re-requests the server projection after a todo update event", async () => {
  mocks.todos.mockResolvedValueOnce(page([todo("重指派前")])).mockResolvedValueOnce(page([todo("重指派后")]));

  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  expect(container.textContent).toContain("重指派前");

  await act(async () => {
    window.dispatchEvent(new CustomEvent("workspace-todos-updated"));
  });

  expect(mocks.todos).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("重指派后");
  expect(container.textContent).not.toContain("重指派前");
});

it("labels report submitters and other todo requesters", async () => {
  mocks.todos.mockResolvedValue(
    page([
      todo("2026-W39 周报", {
        domain: "RESEARCH",
        source: "REPORT",
        requester: { id: "student", display_name: "周报提交人" },
      }),
      todo("科研链任务", {
        domain: "RESEARCH",
        source: "CHAIN_TASK",
        requester: { id: "advisor", display_name: "科研负责人" },
      }),
      todo("行政任务", {
        requester: { id: "admin", display_name: "行政发起人" },
      }),
    ])
  );
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  expect(container.textContent).toContain("提交人：周报提交人");
  expect(container.textContent).toContain("发起人：科研负责人");
  expect(container.textContent).toContain("发起人：行政发起人");
});

it("omits requester metadata when the projection has no requester", async () => {
  mocks.todos.mockResolvedValue(page([todo()]));
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  expect(container.textContent).toContain("采购");
  expect(container.textContent).not.toContain("发起人：");
  expect(container.textContent).not.toContain("提交人：");
});
