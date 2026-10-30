// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({ getResearchTodos: vi.fn() }));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      return typeof value === "string"
        ? value.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ""))
        : key;
    },
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@plane/propel/table", () => ({
  Table: ({ children }: { children: React.ReactNode }) => <table>{children}</table>,
  TableHeader: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
  TableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
  TableRow: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
  TableCell: ({ children }: { children: React.ReactNode }) => <td>{children}</td>,
  TableHead: ({ children }: { children: React.ReactNode }) => <th>{children}</th>,
}));
vi.mock("@/components/research/common/research-browse-toolbar", () => ({
  ResearchBrowseRefresh: ({ onRefresh }: { onRefresh: () => void }) => (
    <button type="button" onClick={onRefresh}>
      刷新
    </button>
  ),
}));
vi.mock("@/services/research/research-todo.service", () => ({
  ResearchTodoService: class {
    getResearchTodos = mocks.getResearchTodos;
  },
}));

const { MyChainStageSubmissions } = await import("@/components/research/approvals/my-chain-stage-submissions");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderList() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <MyChainStageSubmissions workspaceSlug="lab" />
      </MemoryRouter>
    );
  });
  await act(async () => undefined);
}

function todo(seed: Record<string, unknown>) {
  return {
    schema_version: "research-todo.v2",
    id: "todo-1",
    source: "CHAIN_STAGE_APPROVAL",
    object_id: "stage-1",
    title: "新材料课题 · 开题",
    context: "科研链阶段审批 · ADVISOR",
    requester: null,
    assignees: [{ id: "advisor", display_name: "王导师" }],
    business_status: "AWAITING_ADVISOR",
    handling_status: "IN_PROGRESS",
    next_action: "READ",
    due_at: null,
    urgency: "NORMAL",
    href: "/lab/research/chains/chain-1?tab=nodes",
    capabilities: { schema_version: "research-capabilities.v1", actions: {} },
    trace_ref: null,
    updated_at: "2026-10-30T08:00:00Z",
    ...seed,
  };
}

it("shows an owner-friendly stage list without review actions", async () => {
  mocks.getResearchTodos.mockResolvedValue({
    schema_version: "research-todo.v2",
    results: [todo({})],
    count: 1,
    total_count: 1,
    next_cursor: null,
    degraded_sources: [],
  });
  await renderList();

  expect(mocks.getResearchTodos).toHaveBeenCalledWith("lab", { scope: "mine", limit: 100 });
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/lab/research/chains/chain-1?tab=nodes");
  expect(container.textContent).toContain("待导师审");
  expect(container.textContent).toContain("王导师");
  expect(container.textContent).not.toContain("通过");
  expect(container.textContent).not.toContain("驳回");
});

it("separates the empty and failed list states", async () => {
  mocks.getResearchTodos.mockResolvedValue({
    schema_version: "research-todo.v2",
    results: [],
    count: 0,
    total_count: 0,
    next_cursor: null,
    degraded_sources: [],
  });
  await renderList();
  expect(container.textContent).toContain("暂无阶段提交记录");

  mocks.getResearchTodos.mockRejectedValue(new Error("network"));
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "刷新")?.click();
  });
  await act(async () => undefined);
  expect(container.textContent).toContain("无法加载阶段提交，请重试。");
});
