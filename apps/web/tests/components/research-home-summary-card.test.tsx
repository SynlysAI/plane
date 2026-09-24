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
  expect(container.querySelector('a[href="/lab/research"]')).not.toBeNull();
});

it("does not leak chain content when the summary is forbidden", async () => {
  mocks.getChains.mockRejectedValue({ error_code: "research_permission_denied" });

  await act(async () => root.render(<ResearchHomeSummaryCard workspaceSlug="lab" />));

  expect(container.textContent).toContain("当前账号没有科研数据访问权限。");
  expect(container.textContent).not.toContain("高分子课题");
});
