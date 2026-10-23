// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TResearchTodoEnvelope, TResearchTodoEnvelopeList } from "@plane/types";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({ getResearchTodos: vi.fn() }));

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

vi.mock("@/services/research/research-todo.service", () => ({
  ResearchTodoService: class {
    getResearchTodos = mocks.getResearchTodos;
  },
}));
vi.mock("@plane/propel/table", () => ({
  Table: ({ children }: { children: React.ReactNode }) => <table>{children}</table>,
  TableHeader: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
  TableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
  TableRow: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
  TableHead: ({ children }: { children: React.ReactNode }) => <th>{children}</th>,
  TableCell: ({ children }: { children: React.ReactNode }) => <td>{children}</td>,
}));
vi.mock("@plane/propel/tab-navigation", () => ({
  TabNavigationList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabNavigationItem: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/research/common/research-browse-toolbar", () => ({
  ResearchBrowseRefresh: () => <button type="button">refresh</button>,
}));

const { ChainStageApprovalInbox } = await import("@/components/research/approvals/chain-stage-approval-inbox");

function todo(id: string, status: string, canApprove: boolean, assigneeCount = 1): TResearchTodoEnvelope {
  return {
    schema_version: "research-todo.v2",
    id,
    source: "CHAIN_STAGE_APPROVAL",
    object_id: id,
    title: `课题 ${id}`,
    context: "科研链阶段审批 · ADVISOR",
    requester: null,
    assignees: Array.from({ length: assigneeCount }, (_item, index) => ({
      id: `${id}-user-${index}`,
      display_name: "审核人",
      email: "reviewer@example.com",
    })),
    business_status: status,
    handling_status: "IN_PROGRESS",
    next_action: "APPROVE",
    due_at: null,
    urgency: "NORMAL",
    href: `/lab/research/chains/chain-${id}?tab=nodes&stage=pre_experiment`,
    capabilities: {
      schema_version: "research-capabilities.v1",
      actions: {
        view: { allowed: true, reason_code: "allowed", reason: "允许" },
        approve: {
          allowed: canApprove,
          reason_code: canApprove ? "allowed" : "research_permission_denied",
          reason: canApprove ? "允许" : "无权限",
        },
        reject: {
          allowed: canApprove,
          reason_code: canApprove ? "allowed" : "research_permission_denied",
          reason: canApprove ? "允许" : "无权限",
        },
      },
    },
    trace_ref: null,
    updated_at: "2026-10-22T01:00:00Z",
  } as TResearchTodoEnvelope;
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
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

it("renders readable queue states and auto-expanding deep links", async () => {
  const payload = {
    schema_version: "research-todo-list.v2",
    results: [
      todo("mine", "AWAITING_ADVISOR", true),
      todo("other", "AWAITING_PI", false),
      todo("blocked", "AWAITING_ADVISOR", false, 0),
    ],
    count: 3,
    total_count: 3,
    next_cursor: null,
    degraded_sources: [],
  } as TResearchTodoEnvelopeList;
  mocks.getResearchTodos.mockResolvedValue(payload);

  await act(async () => {
    root.render(
      <MemoryRouter>
        <ChainStageApprovalInbox workspaceSlug="lab" />
      </MemoryRouter>
    );
  });
  await act(async () => undefined);

  expect(container.textContent).toContain("等待导师");
  expect(container.textContent).toContain("等待主 PI");
  expect(container.textContent).toContain("等待本人");
  expect(container.textContent).toContain("等待他人");
  expect(container.textContent).toContain("配置阻塞");
  expect([...container.querySelectorAll("a")].every((link) => link.getAttribute("href")?.includes("approval=1"))).toBe(
    true
  );
});
