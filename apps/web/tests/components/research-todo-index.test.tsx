// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TResearchTodoEnvelope, TResearchTodoEnvelopeList } from "@plane/types";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  getResearchTodos: vi.fn(),
  getChainNodes: vi.fn(),
  getKnowledgeUploads: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@plane/i18n", () => ({
  DEFAULT_LANGUAGE: "zh-CN",
  useTranslation: () => ({
    t: (key: string) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      return typeof value === "string" ? value : key;
    },
  }),
}));
vi.mock("@/services/research/research-todo.service", () => ({
  ResearchTodoService: class {
    getResearchTodos = mocks.getResearchTodos;
  },
}));
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    getChainNodes = mocks.getChainNodes;
    getKnowledgeUploads = mocks.getKnowledgeUploads;
  },
}));

const { ResearchTodoEnvelopeList } = await import("@/components/research/common/research-todo-index");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function todoEnvelope(overrides: Partial<TResearchTodoEnvelope> = {}): TResearchTodoEnvelope {
  return {
    schema_version: "research-todo.v2",
    id: "REPORT:report-1",
    source: "REPORT",
    object_id: "report-1",
    title: "报告需修订 · 2026-W38",
    context: "高分子课题 / 周报",
    requester: { id: "student-1", display_name: "学生一" },
    assignees: [{ id: "advisor-1", display_name: "导师一" }],
    business_status: "NEEDS_REVISION",
    handling_status: "RETURNED",
    next_action: "SUBMIT",
    due_at: "2026-09-30T00:00:00Z",
    href: "/lab/research/reports/report-1",
    capabilities: {
      schema_version: "research-capabilities.v1",
      actions: {},
    },
    trace_ref: null,
    updated_at: "2026-09-22T00:00:00Z",
    ...overrides,
  };
}

function todoList(results: TResearchTodoEnvelope[], totalCount = results.length): TResearchTodoEnvelopeList {
  return {
    schema_version: "research-todo.v2",
    results,
    count: results.length,
    total_count: totalCount,
    next_cursor: null,
    degraded_sources: [],
  };
}

function button(label: string) {
  const target = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(target).toBeDefined();
  return target as HTMLButtonElement;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getResearchTodos.mockResolvedValue(todoList([]));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("uses one server aggregate request and never polls chain upload status", async () => {
  mocks.getResearchTodos.mockResolvedValue(
    todoList([
      todoEnvelope({
        id: "CHAIN_TASK:task-1",
        source: "CHAIN_TASK",
        object_id: "task-1",
        title: "补充实验数据",
        context: "高分子课题 / 数据分析",
        requester: { id: "student-1", display_name: "学生一" },
        assignees: [{ id: "member-1", display_name: "处理人一" }],
        business_status: "FAILED",
        handling_status: "BLOCKED",
        next_action: "SUBMIT",
        href: "/lab/research/chains/chain-1?node=node-1",
        updated_at: "2026-09-23T00:00:00Z",
      }),
      todoEnvelope(),
    ])
  );

  await act(async () => root.render(<ResearchTodoEnvelopeList workspaceSlug="lab" limit={12} />));

  expect(mocks.getResearchTodos).toHaveBeenCalledTimes(1);
  expect(mocks.getResearchTodos).toHaveBeenCalledWith("lab", { scope: "to_me", limit: 100 });
  expect(mocks.getChainNodes).not.toHaveBeenCalled();
  expect(mocks.getKnowledgeUploads).not.toHaveBeenCalled();
  const rows = [...container.querySelectorAll("li")];
  expect(rows[0]?.textContent).toContain("补充实验数据");
  expect(rows[0]?.textContent).toContain("处理人一");
  expect(rows[1]?.textContent).toContain("报告需修订 · 2026-W38");
  expect(container.querySelector('a[href="/lab/research/chains/chain-1?node=node-1"]')).not.toBeNull();
});

it("uses server-computed next actions without rendering trace payloads", async () => {
  mocks.getResearchTodos.mockResolvedValue(
    todoList([
      todoEnvelope({
        id: "REPORT:report-unread",
        title: "周报待阅读 · 2026-W40",
        business_status: "SUBMITTED",
        handling_status: "TODO",
        next_action: "READ",
        href: "/lab/research/reports/report-unread",
        trace_ref: {
          resource_type: "report",
          resource_id: "report-unread",
          trace_id: "secret-trace-id",
        },
      }),
      todoEnvelope({
        id: "REPORT:report-review",
        title: "周报待审阅 · 2026-W39",
        next_action: "REVIEW",
        href: "/lab/research/reports/report-review",
      }),
    ])
  );

  await act(async () => root.render(<ResearchTodoEnvelopeList workspaceSlug="lab" limit={12} />));

  expect(container.textContent).toContain("周报待阅读 · 2026-W40");
  expect(container.textContent).toContain("周报待审阅 · 2026-W39");
  expect(container.textContent).toContain("阅读");
  expect(container.textContent).toContain("审阅");
  expect(container.textContent).not.toContain("secret-trace-id");
  const mutationButtons = [...container.querySelectorAll("button")].filter((item) => item.textContent !== "刷新待办");
  expect(mutationButtons).toEqual([]);
});

it("filters the server projection by the selected period in one request", async () => {
  mocks.getResearchTodos.mockResolvedValue(
    todoList([
      todoEnvelope({ id: "REPORT:new", title: "新待办", updated_at: "2026-10-09T00:00:00Z" }),
      todoEnvelope({ id: "REPORT:old", title: "旧待办", updated_at: "2026-08-01T00:00:00Z" }),
    ])
  );

  await act(async () => root.render(<ResearchTodoEnvelopeList workspaceSlug="lab" periodDays={30} limit={12} />));

  expect(mocks.getResearchTodos).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("新待办");
  expect(container.textContent).not.toContain("旧待办");
});

it("renders the loading state with stable accessibility semantics", async () => {
  mocks.getResearchTodos.mockReturnValue(new Promise(() => undefined));
  await act(async () => root.render(<ResearchTodoEnvelopeList workspaceSlug="lab" />));
  expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
});

it("renders the explicit empty state", async () => {
  mocks.getResearchTodos.mockResolvedValue(todoList([]));
  await act(async () => root.render(<ResearchTodoEnvelopeList workspaceSlug="lab" />));
  expect(container.textContent).toContain("当前没有需要处理的跨组件事项。");
});

it("renders the error state and retries the aggregate request", async () => {
  mocks.getResearchTodos.mockRejectedValueOnce(new Error("network"));
  await act(async () => root.render(<ResearchTodoEnvelopeList workspaceSlug="lab" />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("科研待办暂时不可用");

  mocks.getResearchTodos.mockResolvedValueOnce(todoList([todoEnvelope()]));
  await act(async () => button("重试").click());
  expect(mocks.getResearchTodos).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("报告需修订 · 2026-W38");
});

it("refreshes the aggregate projection without adding source requests", async () => {
  mocks.getResearchTodos
    .mockResolvedValueOnce(todoList([todoEnvelope({ title: "刷新前待办" })]))
    .mockResolvedValueOnce(todoList([todoEnvelope({ title: "刷新后待办" })]));

  await act(async () => root.render(<ResearchTodoEnvelopeList workspaceSlug="lab" />));
  expect(container.textContent).toContain("刷新前待办");

  await act(async () => button("刷新待办").click());

  expect(mocks.getResearchTodos).toHaveBeenCalledTimes(2);
  expect(mocks.getKnowledgeUploads).not.toHaveBeenCalled();
  expect(container.textContent).toContain("刷新后待办");
  expect(container.textContent).not.toContain("刷新前待办");
});
