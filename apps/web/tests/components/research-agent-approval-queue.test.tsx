// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  getApprovals: vi.fn(),
  decideApproval: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      if (typeof value !== "string") return key;
      return value.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ""));
    },
  }),
}));
vi.mock("@/services/research/agent.service", () => ({
  ResearchAgentService: class {
    getApprovals = mocks.getApprovals;
    decideApproval = mocks.decideApproval;
  },
}));

const { ResearchAgentApprovalQueue } = await import("@/components/research/approvals/research-agent-approval-queue");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const approval = {
  session_id: "session-1",
  run_id: "run-1",
  workspace: "ws",
  user: "user-1",
  user_detail: { display_name: "李研究员", email: "researcher@example.com" },
  project: "project-1",
  project_name: "高分子稳定性课题",
  chain: "chain-1",
  chain_node: "node-1",
  chain_node_title: "文献调研",
  status: "WAITING_APPROVAL",
  tool_call_id: "tool-1",
  summary: "检索聚合物 Tg 文献",
  risk_level: "MEDIUM",
  capability_scope: "knowledge.search",
  created_at: "2026-09-23T01:00:00Z",
  updated_at: "2026-09-23T01:00:00Z",
};

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

it("renders real Agent approvals with topic and node context", async () => {
  mocks.getApprovals.mockResolvedValue({ results: [approval], count: 1 });
  await act(async () => root.render(<ResearchAgentApprovalQueue workspaceSlug="lab" />));

  expect(container.textContent).toContain("高分子稳定性课题");
  expect(container.textContent).toContain("文献调研");
  expect(container.textContent).toContain("李研究员");
  expect(container.textContent).toContain("检索聚合物 Tg 文献");
  expect(container.textContent).toContain("中");
  expect(container.querySelector('a[href="/lab/research/chains/chain-1?tab=nodes&node=node-1"]')).not.toBeNull();
});

it("submits an idempotent rejection with a reason and refreshes the queue", async () => {
  mocks.getApprovals.mockResolvedValueOnce({ results: [approval], count: 1 });
  mocks.getApprovals.mockResolvedValueOnce({ results: [], count: 0 });
  mocks.decideApproval.mockResolvedValue({});
  await act(async () => root.render(<ResearchAgentApprovalQueue workspaceSlug="lab" />));

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "处理审批")?.click();
  });
  const textarea = container.querySelector("textarea");
  await act(async () => {
    if (textarea instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "超出当前节点授权范围");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "驳回")?.click();
  });

  expect(mocks.decideApproval).toHaveBeenCalledWith(
    "lab",
    "run-1",
    expect.objectContaining({
      decision: "REJECTED",
      tool_call_id: "tool-1",
      reason: "超出当前节点授权范围",
    })
  );
  expect(mocks.getApprovals).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("Agent 审批已拒绝。");
});
