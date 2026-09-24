// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  research: {
    identityWorkspaceSlug: "lab",
    identity: { module_enabled: true, workspace_enabled: true, sections: { research_chain: true } },
    canSee: (key: string) => key === "research_chain",
    fetchIdentity: vi.fn(),
  },
  getChains: vi.fn(),
  getChainNodes: vi.fn(),
  getChainNodeDetail: vi.fn(),
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
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    getChains = mocks.getChains;
    getChainNodes = mocks.getChainNodes;
    getChainNodeDetail = mocks.getChainNodeDetail;
  },
}));
vi.mock("@/services/research/report.service", () => ({
  ResearchReportService: class {
    getReports = vi.fn().mockResolvedValue({ results: [], count: 0 });
  },
}));
vi.mock("@/services/research/review.service", () => ({
  ResearchReviewService: class {
    getReviews = vi.fn().mockResolvedValue({ results: [] });
  },
}));
vi.mock("@/services/research/approval.service", () => ({
  ResearchApprovalService: class {
    getApprovalRequests = vi.fn().mockResolvedValue({ results: [], count: 0 });
  },
}));
vi.mock("@/services/research/agent.service", () => ({
  ResearchAgentService: class {
    getApprovals = vi.fn().mockResolvedValue({ results: [], count: 0 });
  },
}));
vi.mock("@/services/research/integration.service", () => ({
  ResearchIntegrationService: class {
    getConnections = vi.fn().mockResolvedValue({ results: [] });
  },
}));

const { ResearchHomeSummaryCard } = await import("@/components/research/common/research-home-summary-card");

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

it("shows the latest visible chain, current node and snapshot", async () => {
  const chain = {
    schema_version: "research-chain.v1",
    id: "chain-1",
    project: "高分子课题",
    workspace: "ws",
    owner: "user-1",
    status: "ACTIVE",
    visibility: "PRIVATE",
    created_at: "2026-09-20T00:00:00Z",
    updated_at: "2026-09-23T00:00:00Z",
  };
  const node = {
    schema_version: "research-node.v1",
    id: "node-1",
    chain: "chain-1",
    node_type: "ANALYSIS",
    title: "数据分析",
    parent_node: null,
    loop_iteration: 0,
    status: "WAITING_HUMAN",
    assignee: "user-1",
    created_at: "2026-09-22T00:00:00Z",
    updated_at: "2026-09-23T00:00:00Z",
  };
  mocks.getChains.mockResolvedValue([chain]);
  mocks.getChainNodes.mockResolvedValue([node]);
  mocks.getChainNodeDetail.mockResolvedValue({
    node,
    events: [],
    snapshots: [{ snapshot_id: "snapshot-1", summary: "模型误差分析已冻结", created_at: "2026-09-23T01:00:00Z" }],
  });

  await act(async () => root.render(<ResearchHomeSummaryCard workspaceSlug="lab" />));

  expect(container.textContent).toContain("数据分析");
  expect(container.textContent).toContain("模型误差分析已冻结");
  expect(container.querySelector('a[href="/lab/research/chains/chain-1?node=node-1"]')).not.toBeNull();
  expect(container.textContent).toContain("处理当前节点");
  expect(container.querySelector('a[href="/lab/research"]')).toBeNull();
});

it("does not leak chain content when the summary is forbidden", async () => {
  mocks.getChains.mockRejectedValue({ error_code: "research_permission_denied" });

  await act(async () => root.render(<ResearchHomeSummaryCard workspaceSlug="lab" />));

  expect(container.textContent).toContain("当前账号没有科研数据访问权限。");
  expect(container.textContent).not.toContain("高分子课题");
});

it("renders the loading and empty states with stable accessibility semantics", async () => {
  mocks.getChains.mockReturnValue(new Promise(() => undefined));
  await act(async () => root.render(<ResearchHomeSummaryCard workspaceSlug="lab" />));
  expect(container.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();

  mocks.getChains.mockResolvedValue([]);
  await act(async () => root.render(<ResearchHomeSummaryCard workspaceSlug="lab" key="empty" />));
  expect(container.textContent).toContain("当前还没有可见研究链。");
  expect(container.textContent).not.toContain("NaN");
});
