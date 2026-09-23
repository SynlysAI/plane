// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  research: {
    identity: { sections: { research_agent: true, research_chain: true } },
    canSee: () => true,
  },
  getChain: vi.fn(),
  getChainNodes: vi.fn(),
  getChainNodeDetail: vi.fn(),
  createChainNode: vi.fn(),
  transitionChainNode: vi.fn(),
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
vi.mock("@/components/research/chains/research-chain-knowledge-panel", () => ({
  ResearchChainKnowledgePanel: () => <div>knowledge-panel</div>,
}));
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    getChain = mocks.getChain;
    getChainNodes = mocks.getChainNodes;
    getChainNodeDetail = mocks.getChainNodeDetail;
    createChainNode = mocks.createChainNode;
    transitionChainNode = mocks.transitionChainNode;
  },
}));

const chain = {
  schema_version: "research-chain.v1",
  id: "chain-1",
  project: "project-1",
  workspace: "ws",
  owner: "user-1",
  status: "ACTIVE",
  visibility: "PRIVATE",
  created_at: "2026-09-23T01:00:00Z",
  updated_at: "2026-09-23T01:00:00Z",
};
const node = {
  schema_version: "research-node.v1",
  id: "node-1",
  chain: "chain-1",
  node_type: "LITERATURE_REVIEW",
  title: "文献调研",
  parent_node: null,
  loop_iteration: 0,
  status: "DRAFT",
  assignee: "user-1",
  created_at: "2026-09-23T01:00:00Z",
  updated_at: "2026-09-23T01:00:00Z",
};

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.getChain.mockResolvedValue(chain);
  mocks.getChainNodes.mockResolvedValue([node]);
  mocks.getChainNodeDetail.mockResolvedValue({
    node,
    events: [
      {
        schema_version: "research-event.v1",
        event_id: "event-1",
        node: "node-1",
        actor: "user-1",
        actor_type: "USER",
        source_system: "PLANE",
        request_id: "request-1",
        trace_id: "",
        event_type: "NODE_CREATED",
        occurred_at: "2026-09-23T01:00:00Z",
        refs: [],
        summary: "创建节点",
        content_hash: "hash-1",
      },
    ],
    snapshots: [
      {
        schema_version: "research-snapshot.v1",
        snapshot_id: "snapshot-1",
        snapshot_type: "PROCESS",
        node: "node-1",
        version: 1,
        source_versions: [],
        resources: [],
        event_range: { first: "event-1", last: "event-1" },
        summary: "文献快照",
        created_by: "user-1",
        content_hash: "hash-1",
        immutable: true,
        created_at: "2026-09-23T01:00:00Z",
      },
    ],
  });
  mocks.transitionChainNode.mockResolvedValue({ node, event: {} });
});

afterEach(() => {
  root.unmount();
  container.remove();
  vi.clearAllMocks();
});

it("opens node evidence and runs lifecycle actions through the service", async () => {
  const { ResearchChainDetail } = await import("@/components/research/chains/research-chain-detail");
  await act(async () => {
    root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />);
  });

  expect(container.textContent).toContain("文献调研");
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "打开时间线")?.click();
  });
  expect(container.textContent).toContain("创建节点");
  expect(container.textContent).toContain("文献快照");

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "启动")?.click();
  });
  expect(mocks.transitionChainNode).toHaveBeenCalledWith("lab", "node-1", "START", undefined);
});
