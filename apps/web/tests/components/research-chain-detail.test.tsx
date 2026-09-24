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
  getChainMembers: vi.fn(),
  createChainNode: vi.fn(),
  transitionChainNode: vi.fn(),
  query: "tab=nodes",
  setSearchParams: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("react-router", () => ({
  useSearchParams: () => [new URLSearchParams(mocks.query), mocks.setSearchParams],
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
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({
    workspace: {
      getWorkspaceMemberIds: () => [],
      fetchWorkspaceMembers: () => Promise.resolve([]),
      isUserSuspended: () => false,
    },
    getUserDetails: () => null,
  }),
}));
vi.mock("@/components/research/experiments/experiment-list", () => ({
  ExperimentList: () => <div>experiment-list</div>,
}));
vi.mock("@/components/research/outcomes/outcome-list", () => ({
  OutcomeList: () => <div>outcome-list</div>,
}));
vi.mock("@/components/research/chains/research-chain-knowledge-panel", () => ({
  ResearchChainKnowledgePanel: ({ chainId, nodeId }: { chainId: string; nodeId: string }) => (
    <div data-testid="chain-knowledge-panel" data-chain={chainId} data-node={nodeId}>
      knowledge-panel
    </div>
  ),
}));
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    getChain = mocks.getChain;
    getChainNodes = mocks.getChainNodes;
    getChainNodeDetail = mocks.getChainNodeDetail;
    getChainMembers = mocks.getChainMembers;
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
  mocks.query = "tab=nodes";
  mocks.getChain.mockResolvedValue(chain);
  mocks.getChainNodes.mockResolvedValue([node]);
  mocks.getChainMembers.mockResolvedValue([]);
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
  mocks.getChainNodes.mockResolvedValue([
    node,
    { ...node, id: "node-2", title: "模型迭代", parent_node: "node-1", loop_iteration: 2 },
  ]);
  await act(async () => {
    root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />);
  });
  await act(async () => undefined);

  expect(container.textContent).toContain("文献调研");
  expect(container.textContent).toContain("创建节点");
  expect(container.textContent).toContain("文献快照");
  expect(container.textContent).toContain("输入");
  expect(container.textContent).toContain("人类决策");
  expect(container.textContent).toContain("R2");
  expect(container.textContent).toContain("阶段节点");
  expect(container.textContent).toContain("快照");
  expect(container.textContent).toContain("Trace log");
  expect(container.querySelector("path[stroke-dasharray='4 4']")).toBeNull();
  expect(
    container.querySelector('a[href="/lab/research/chains/chain-1?tab=nodes"]')?.getAttribute("aria-current")
  ).toBe("page");
  expect(container.querySelector('button[aria-pressed="true"]')).not.toBeNull();
  expect([...container.querySelectorAll("nav a")].map((item) => item.textContent)).toEqual(
    expect.arrayContaining(["课题", "节点", "报告与成果", "实验记录", "外部引用", "成员"])
  );
  expect([...container.querySelectorAll("nav a")].map((item) => item.textContent)).not.toContain("回放");

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "启动")?.click();
  });
  expect(mocks.transitionChainNode).toHaveBeenCalledWith("lab", "node-1", "START", undefined);
});

it("keeps the scoped knowledge upload entry on the references tab", async () => {
  mocks.query = "tab=references";
  const { ResearchChainDetail } = await import("@/components/research/chains/research-chain-detail");
  await act(async () => {
    root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />);
  });
  await act(async () => undefined);

  const panel = container.querySelector('[data-testid="chain-knowledge-panel"]');
  expect(panel?.getAttribute("data-chain")).toBe("chain-1");
  expect(panel?.getAttribute("data-node")).toBe("node-1");
});

it("navigates to an empty stage through the workflow itself", async () => {
  const { ResearchChainDetail } = await import("@/components/research/chains/research-chain-detail");
  await act(async () => {
    root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />);
  });
  await act(async () => undefined);

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("转化"))?.click();
  });

  expect(mocks.setSearchParams).toHaveBeenCalledTimes(1);
  const nextParams = mocks.setSearchParams.mock.calls[0][0] as URLSearchParams;
  expect(nextParams.get("tab")).toBe("nodes");
  expect(nextParams.get("stage")).toBe("transfer");
  expect(nextParams.get("node")).toBeNull();
});

it("normalizes legacy replay links into the workflow detail view", async () => {
  const { ResearchChainDetail } = await import("@/components/research/chains/research-chain-detail");
  mocks.query = "tab=replay&node=node-1";
  await act(async () => {
    root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />);
  });
  await act(async () => undefined);

  expect(
    container.querySelector('a[href="/lab/research/chains/chain-1?tab=nodes"]')?.getAttribute("aria-current")
  ).toBe("page");
  expect([...container.querySelectorAll("nav a")].map((item) => item.textContent)).not.toContain("回放");
  expect(container.textContent).toContain("文献快照");
});

it("renders the fixed thirteen-stage workflow even when later stages have no nodes", async () => {
  const { ResearchChainDetail } = await import("@/components/research/chains/research-chain-detail");
  mocks.getChainNodes.mockResolvedValueOnce([node]);
  await act(async () => {
    root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />);
  });

  const workflow = container.querySelector('[aria-label="研究流程"]');
  expect(workflow).not.toBeNull();
  expect(workflow?.querySelectorAll('[role="listitem"]')).toHaveLength(13);
  expect(workflow?.textContent).toContain("未开始");
  expect(workflow?.textContent).toContain("转化");
  expect(workflow?.querySelector('[aria-current="step"]')?.textContent).toContain("文献调研");
});

it("uses bounded node types and preserves the page when creation fails", async () => {
  const { ResearchChainDetail } = await import("@/components/research/chains/research-chain-detail");
  mocks.createChainNode.mockRejectedValueOnce(new Error("invalid type"));
  await act(async () => {
    root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />);
  });

  const typeSelect = container.querySelector("select");
  expect(typeSelect).not.toBeNull();
  const typeOptions = [...((typeSelect as HTMLSelectElement | null)?.options ?? [])];
  expect(typeOptions.map((option) => option.value)).not.toContain("not-a-research-node");

  const titleInput = container.querySelector('input[placeholder="文献调研、实验或分析"]');
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    if (titleInput instanceof HTMLInputElement) {
      valueSetter?.call(titleInput, "新节点");
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    [...container.querySelectorAll("button")].find((button) => button.textContent === "创建节点")?.click();
  });

  expect(mocks.createChainNode).toHaveBeenCalled();
  expect(container.textContent).toContain("文献调研");
  expect(container.textContent).toContain("操作未完成，请根据提示修改后重试；当前页面内容已保留。");
  expect(container.textContent).not.toContain("无法加载");
});

it("explains that a failure or return reason is required before sending the transition", async () => {
  const { ResearchChainDetail } = await import("@/components/research/chains/research-chain-detail");
  mocks.getChainNodes.mockResolvedValueOnce([{ ...node, status: "ACTIVE" }]);
  mocks.getChainNodeDetail.mockResolvedValueOnce({
    node: { ...node, status: "ACTIVE" },
    events: [],
    snapshots: [],
  });
  await act(async () => {
    root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />);
  });

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "标记失败")?.click();
  });

  expect(mocks.transitionChainNode).not.toHaveBeenCalled();
  expect(container.textContent).toContain("请先填写原因。");
  expect(container.querySelector('input[aria-invalid="true"]')).not.toBeNull();
});
