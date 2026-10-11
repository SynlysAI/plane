// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TResearchTodoEnvelope, TResearchTodoEnvelopeList } from "@plane/types";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  collectResearchTodos: vi.fn(),
  getChainNodes: vi.fn(),
  getKnowledgeUploads: vi.fn(),
  getResearchTodos: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      return typeof value === "string" ? value : key;
    },
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@plane/propel/skeleton", () => ({
  Skeleton: { Item: () => <div /> },
}));
vi.mock("@/components/research/common/research-status-badge", () => ({
  ResearchStatusBadge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/research/common/research-format", () => ({
  formatResearchDate: (value: string) => value,
}));
vi.mock("@/components/research/common/research-todo-urgency", () => ({
  ResearchTodoUrgency: () => null,
}));
vi.mock("@/components/research/common/research-tab-link", async () => {
  const { Link } = await import("react-router");
  return {
    ResearchTabLink: ({ href, isActive, children }: { href: string; isActive: boolean; children: React.ReactNode }) => (
      <Link to={href} aria-current={isActive ? "page" : undefined}>
        {children}
      </Link>
    ),
  };
});
vi.mock("@/components/research/common/research-page-shell", () => ({
  ResearchPageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/research/approvals/approval-list", () => ({
  ResearchApprovalList: () => <div>office-approvals</div>,
}));
vi.mock("@/components/research/approvals/research-agent-approval-queue", () => ({
  ResearchAgentApprovalQueue: () => <div>agent-approval-queue</div>,
}));
vi.mock("@/components/research/reports/report-list", () => ({
  ResearchReportList: () => <div>report-list</div>,
}));
vi.mock("@/components/research/reviews/review-inbox", () => ({
  ReviewInbox: () => <div>review-inbox</div>,
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
vi.mock("@/components/research/common/research-todo-source", () => ({
  collectResearchTodos: mocks.collectResearchTodos,
}));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    identity: {
      sections: {
        reports: true,
        approvals: true,
        stages: true,
        research_chain: true,
        research_agent: true,
      },
    },
    isIaV2Enabled: true,
    isWorkspaceAdmin: false,
    canSee: () => true,
  }),
}));

const { ResearchApprovalCenter } = await import("@/components/research/approvals/research-approval-center");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let currentSearch = "";

function RouteProbe() {
  const location = useLocation();
  currentSearch = location.search;
  return null;
}

function todo(): TResearchTodoEnvelope {
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
    due_at: null,
    urgency: "NORMAL",
    href: "/lab/research/reports/report-1",
    capabilities: { schema_version: "research-capabilities.v1", actions: {} },
    trace_ref: null,
    updated_at: "2026-10-09T00:00:00Z",
  };
}

function todoList(
  results: TResearchTodoEnvelope[] = [],
  degradedSources: TResearchTodoEnvelopeList["degraded_sources"] = []
): TResearchTodoEnvelopeList {
  return {
    schema_version: "research-todo.v2",
    results,
    count: results.length,
    total_count: results.length,
    next_cursor: null,
    degraded_sources: degradedSources,
  };
}

function renderCenter(initialPath: string) {
  return act(async () =>
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <ResearchApprovalCenter workspaceSlug="lab" />
        <RouteProbe />
      </MemoryRouter>
    )
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  currentSearch = "";
  mocks.getResearchTodos.mockResolvedValue(todoList([todo()]));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("renders the shared todo envelope above capability-filtered domain tabs", async () => {
  await renderCenter("/lab/research/approvals?tab=report_review");
  await act(async () => undefined);

  const sharedTodos = container.querySelectorAll('section[aria-label="跨组件待办"]');
  expect(sharedTodos).toHaveLength(1);
  expect(mocks.getResearchTodos).toHaveBeenCalledWith("lab", { scope: "to_me", limit: 100 });
  expect(container.textContent).toContain("报告需修订 · 2026-W38");
  expect(container.querySelector('a[href="/lab/research/reports/report-1"]')).not.toBeNull();
  expect(container.textContent).toContain("报告");
  expect(mocks.collectResearchTodos).not.toHaveBeenCalled();
  expect(mocks.getChainNodes).not.toHaveBeenCalled();
  expect(mocks.getKnowledgeUploads).not.toHaveBeenCalled();
});

it("keeps todo scope while switching approval domain tabs", async () => {
  await renderCenter("/lab/research/approvals?tab=report_review");
  await act(async () => undefined);

  const visibleButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "全部可见");
  await act(async () => visibleButton?.click());
  expect(mocks.getResearchTodos).toHaveBeenLastCalledWith("lab", { scope: "visible", limit: 100 });
  expect(currentSearch).toBe("?tab=report_review&todo_scope=visible");

  const agentTab = [...container.querySelectorAll("a")].find((link) => link.getAttribute("href")?.includes("agent"));
  expect(agentTab?.getAttribute("href")).toBe("/lab/research/approvals?tab=agent_approval&todo_scope=visible");
  await act(async () => agentTab?.click());
  await act(async () => undefined);

  expect(currentSearch).toBe("?tab=agent_approval&todo_scope=visible");
  expect(container.textContent).toContain("agent-approval-queue");
  expect(container.querySelector('section[aria-label="跨组件待办"]')).not.toBeNull();
  expect(container.querySelector('a[href="/lab/research/reports/report-1"]')).not.toBeNull();
});

it("keeps degraded sources visible and the approval layout inside the viewport", async () => {
  mocks.getResearchTodos.mockResolvedValue(todoList([todo()], ["AGENT_APPROVAL"]));
  await renderCenter("/lab/research/approvals?todo_scope=visible");
  await act(async () => undefined);

  expect(container.querySelector('[role="status"]')?.textContent).toContain("Agent 审批");
  expect(container.textContent).toContain("报告需修订 · 2026-W38");
  expect(container.querySelector("section")?.className).toContain("min-w-0");
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
});
