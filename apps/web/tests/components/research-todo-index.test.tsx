// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TResearchTodoEnvelope, TResearchTodoEnvelopeList } from "@plane/types";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  getResearchTodos: vi.fn(),
  getChainNodes: vi.fn(),
  getKnowledgeUploads: vi.fn(),
  copyTextToClipboard: vi.fn(),
  setToast: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@plane/i18n", () => ({
  DEFAULT_LANGUAGE: "zh-CN",
  useTranslation: () => ({
    t: (key: string, values: Record<string, string | number> = {}) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      const text = typeof value === "string" ? value : key;
      return Object.entries(values).reduce(
        (result, [name, item]) => result.replaceAll(`{${name}}`, String(item)),
        text
      );
    },
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@/services/research/research-todo.service", () => ({
  ResearchTodoService: class {
    getResearchTodos = mocks.getResearchTodos;
  },
}));
vi.mock("@plane/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@plane/utils")>()),
  copyTextToClipboard: mocks.copyTextToClipboard,
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "SUCCESS", ERROR: "ERROR" },
  setToast: mocks.setToast,
}));
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    getChainNodes = mocks.getChainNodes;
    getKnowledgeUploads = mocks.getKnowledgeUploads;
  },
}));
vi.mock("@/components/research/approvals/research-chain-stage-approval-queue", () => ({
  ResearchChainStageApprovalQueue: ({ activeId, onHandled }: { activeId: string; onHandled: (id: string) => void }) => (
    <aside data-testid="stage-approval-queue">
      <button type="button" onClick={() => onHandled(activeId)}>
        handle queue item
      </button>
    </aside>
  ),
}));

const { ResearchTodoEnvelopeList } = await import("@/components/research/common/research-todo-index");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let currentSearch = "";

function RouteProbe() {
  const location = useLocation();
  currentSearch = location.search;
  return null;
}

function renderTodo(initialPath = "/lab", props: Partial<Parameters<typeof ResearchTodoEnvelopeList>[0]> = {}) {
  return act(async () =>
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <ResearchTodoEnvelopeList workspaceSlug="lab" {...props} />
        <RouteProbe />
      </MemoryRouter>
    )
  );
}

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
    urgency: "NORMAL",
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

it("renders server urgency with an explicit textual label beside the due date", async () => {
  mocks.getResearchTodos.mockResolvedValue(
    todoList([
      todoEnvelope({
        title: "逾期节点任务",
        due_at: "2026-10-09T08:00:00Z",
        urgency: "OVERDUE",
      }),
      todoEnvelope({
        title: "今天截止报告",
        due_at: "2026-10-10T18:30:00Z",
        urgency: "DUE_TODAY",
      }),
    ])
  );

  await renderTodo("/lab", { limit: 12 });

  expect(container.textContent).toContain("逾期");
  expect(container.textContent).toContain("今天截止");
  expect(container.textContent).toContain("截止：");
});

function todoList(
  results: TResearchTodoEnvelope[],
  totalCount = results.length,
  degradedSources: TResearchTodoEnvelopeList["degraded_sources"] = []
): TResearchTodoEnvelopeList {
  return {
    schema_version: "research-todo.v2",
    results,
    count: results.length,
    total_count: totalCount,
    next_cursor: null,
    degraded_sources: degradedSources,
  };
}

function button(label: string) {
  const target = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(target).toBeDefined();
  return target as HTMLButtonElement;
}

/**
 * 按可访问名称查找按钮，避免同屏多个复制按钮误点。
 *
 * Args:
 *   label: 目标按钮的可访问名称。
 *
 * Returns:
 *   匹配的按钮元素。
 */
function buttonByName(label: string) {
  const target = container.querySelector(`button[aria-label="${label}"]`);
  expect(target).toBeInstanceOf(HTMLButtonElement);
  return target as HTMLButtonElement;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getResearchTodos.mockResolvedValue(todoList([]));
  mocks.copyTextToClipboard.mockReset();
  mocks.copyTextToClipboard.mockResolvedValue(undefined);
  mocks.setToast.mockReset();
  currentSearch = "";
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

  await renderTodo("/lab", { limit: 12 });

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
      todoEnvelope({
        id: "CHAIN_TASK:task-unassigned",
        source: "CHAIN_TASK",
        object_id: "task-unassigned",
        title: "未指派节点任务",
        next_action: "ASSIGN",
        href: "/lab/research/chains/chain-1?node=node-1&task=task-unassigned",
      }),
    ])
  );

  await renderTodo("/lab", { limit: 12 });

  expect(container.textContent).toContain("周报待阅读 · 2026-W40");
  expect(container.textContent).toContain("周报待审阅 · 2026-W39");
  expect(container.textContent).toContain("阅读");
  expect(container.textContent).toContain("审阅");
  expect(container.textContent).toContain("指派");
  expect(container.textContent).not.toContain("secret-trace-id");
  const controls = [...container.querySelectorAll("button")].map((item) => item.textContent ?? "");
  expect(controls.every((label) => ["刷新待办", "我可处理", "我发起", "全部可见", "复制"].includes(label))).toBe(true);
});

it("filters the server projection by the selected period in one request", async () => {
  mocks.getResearchTodos.mockResolvedValue(
    todoList([
      todoEnvelope({ id: "REPORT:new", title: "新待办", updated_at: "2026-10-09T00:00:00Z" }),
      todoEnvelope({ id: "REPORT:old", title: "旧待办", updated_at: "2026-08-01T00:00:00Z" }),
    ])
  );

  await renderTodo("/lab", { periodDays: 30, limit: 12 });

  expect(mocks.getResearchTodos).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("新待办");
  expect(container.textContent).not.toContain("旧待办");
});

it("renders the loading state with stable accessibility semantics", async () => {
  mocks.getResearchTodos.mockReturnValue(new Promise(() => undefined));
  await renderTodo("/lab");
  expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
});

it("renders scope-specific empty states and writes every scope to the URL", async () => {
  mocks.getResearchTodos.mockResolvedValue(todoList([]));
  await renderTodo("/lab");
  expect(container.textContent).toContain("当前没有需要你处理的事项。");

  await act(async () => button("我发起").click());
  expect(currentSearch).toBe("?todo_scope=mine");
  expect(mocks.getResearchTodos).toHaveBeenLastCalledWith("lab", { scope: "mine", limit: 100 });
  expect(container.textContent).toContain("当前没有你发起或提交的事项。");

  await act(async () => button("全部可见").click());
  expect(currentSearch).toBe("?todo_scope=visible");
  expect(mocks.getResearchTodos).toHaveBeenLastCalledWith("lab", { scope: "visible", limit: 100 });
  expect(container.textContent).toContain("当前权限范围内暂无可见事项。");

  await act(async () => button("我可处理").click());
  expect(currentSearch).toBe("?todo_scope=to_me");
  expect(mocks.getResearchTodos).toHaveBeenLastCalledWith("lab", { scope: "to_me", limit: 100 });
});

it("restores the URL scope after a refresh and keeps the layout inside the viewport", async () => {
  mocks.getResearchTodos.mockResolvedValue(todoList([todoEnvelope()]));
  await renderTodo("/lab?todo_scope=visible");

  expect(mocks.getResearchTodos).toHaveBeenCalledWith("lab", { scope: "visible", limit: 100 });
  expect(currentSearch).toBe("?todo_scope=visible");
  expect(container.querySelector("section")?.className).toContain("min-w-0");
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});

it("shows partial degradation while retaining the available server projection", async () => {
  mocks.getResearchTodos.mockResolvedValue(todoList([todoEnvelope()], 1, ["PAPER_REVIEW"]));
  await renderTodo("/lab?todo_scope=to_me");

  expect(container.textContent).toContain("报告需修订 · 2026-W38");
});

it("renders recoverable errors for permission, conflict and server failures", async () => {
  mocks.getResearchTodos.mockRejectedValueOnce({ error_code: "research_permission_denied", status: 403 });
  await renderTodo("/lab");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("当前账号没有权限查看科研待办");

  await act(async () => root.unmount());
  container.remove();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getResearchTodos.mockRejectedValueOnce({ error_code: "INVALID_TRANSITION", status: 409 });
  await renderTodo("/lab");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("待办状态已变化");

  await act(async () => root.unmount());
  container.remove();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getResearchTodos.mockRejectedValueOnce({ error_code: "server_error", status: 503 });
  await renderTodo("/lab");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("科研待办暂时不可用");

  mocks.getResearchTodos.mockResolvedValueOnce(todoList([todoEnvelope()]));
  await act(async () => button("重试").click());
  expect(mocks.getResearchTodos).toHaveBeenCalledTimes(4);
  expect(container.textContent).toContain("报告需修订 · 2026-W38");
});

it("renders the error state and retries the aggregate request", async () => {
  mocks.getResearchTodos.mockRejectedValueOnce(new Error("network"));
  await renderTodo("/lab");
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

  await renderTodo("/lab");
  expect(container.textContent).toContain("刷新前待办");

  await act(async () => button("刷新待办").click());

  expect(mocks.getResearchTodos).toHaveBeenCalledTimes(2);
  expect(mocks.getKnowledgeUploads).not.toHaveBeenCalled();
  expect(container.textContent).toContain("刷新后待办");
  expect(container.textContent).not.toContain("刷新前待办");
});

it("refreshes from the server after a workspace todo update event", async () => {
  mocks.getResearchTodos
    .mockResolvedValueOnce(todoList([todoEnvelope({ title: "事件前待办" })]))
    .mockResolvedValueOnce(todoList([todoEnvelope({ title: "事件后待办" })]));

  await renderTodo("/lab");
  expect(container.textContent).toContain("事件前待办");

  vi.useFakeTimers();
  await act(async () => {
    window.dispatchEvent(new CustomEvent("workspace-todos-updated"));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  vi.useRealTimers();

  expect(mocks.getResearchTodos).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("事件后待办");
  expect(container.textContent).not.toContain("事件前待办");
});

it("keeps the previous research todo rows visible during a silent refresh", async () => {
  let resolveRefresh!: (value: TResearchTodoEnvelopeList) => void;
  mocks.getResearchTodos
    .mockResolvedValueOnce(todoList([todoEnvelope({ title: "刷新前待办" })]))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve;
        })
    );

  await renderTodo("/lab");
  expect(container.textContent).toContain("刷新前待办");

  vi.useFakeTimers();
  await act(async () => {
    window.dispatchEvent(new CustomEvent("workspace-todos-updated"));
  });

  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(container.textContent).toContain("刷新前待办");

  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  vi.useRealTimers();

  await act(async () => resolveRefresh(todoList([todoEnvelope({ title: "刷新后待办" })])));
  expect(container.textContent).toContain("刷新后待办");
  expect(container.textContent).not.toContain("刷新前待办");
});

it("opens chain-stage approvals in the continuous queue and hides handled items", async () => {
  mocks.getResearchTodos.mockResolvedValue(
    todoList([
      todoEnvelope({
        id: "CHAIN_STAGE_APPROVAL:stage-1",
        source: "CHAIN_STAGE_APPROVAL",
        object_id: "stage-1",
        title: "阶段审批一",
        next_action: "APPROVE",
        href: "/lab/research/chains/chain-1?stage=topic_evaluation&approval=1",
      }),
      todoEnvelope({ title: "普通报告待办" }),
    ])
  );

  await renderTodo("/lab");
  await act(async () => container.querySelector('a[href*="stage=topic_evaluation"]')?.click());

  expect(container.querySelector('[data-testid="stage-approval-queue"]')).not.toBeNull();

  await act(async () => button("handle queue item").click());

  expect(container.textContent).not.toContain("阶段审批一");
  expect(container.textContent).toContain("普通报告待办");
});

it("copies a research todo share link without opening the stage approval queue", async () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(window, "location");
  Object.defineProperty(window, "location", {
    value: { origin: "http://pilab.local" },
    configurable: true,
  });
  mocks.getResearchTodos.mockResolvedValue(
    todoList([
      todoEnvelope({
        id: "CHAIN_STAGE_APPROVAL:stage-1",
        source: "CHAIN_STAGE_APPROVAL",
        object_id: "stage-1",
        title: "阶段审批一",
        next_action: "APPROVE",
        href: "/lab/research/chains/chain-1?stage=topic_evaluation&approval=1",
      }),
    ])
  );

  try {
    await renderTodo("/lab");
    await act(async () => buttonByName("复制分享链接：阶段审批一").click());

    expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(
      "Plane 科研行动项: 阶段审批一 ( http://pilab.local/lab/research/chains/chain-1?stage=topic_evaluation&approval=1 )"
    );
    expect(container.querySelector('[data-testid="stage-approval-queue"]')).toBeNull();
    expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ type: "SUCCESS" }));
  } finally {
    if (locationDescriptor) Object.defineProperty(window, "location", locationDescriptor);
  }
});

it("ignores a stale response after the selected scope changes", async () => {
  let resolveStale!: (value: unknown) => void;
  mocks.getResearchTodos.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveStale = resolve;
      })
  );
  mocks.getResearchTodos.mockResolvedValueOnce(todoList([todoEnvelope({ title: "当前范围待办" })]));

  await renderTodo("/lab?todo_scope=to_me");
  await act(async () => button("全部可见").click());
  await act(async () => undefined);
  await act(async () => resolveStale(todoList([todoEnvelope({ title: "旧范围待办" })])));

  expect(container.textContent).toContain("当前范围待办");
  expect(container.textContent).not.toContain("旧范围待办");
});
