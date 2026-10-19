// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  research: {
    identity: { sections: { research_chain: true } },
    canSee: () => true,
  },
  getChain: vi.fn(),
  getChainNodes: vi.fn(),
  getChainNodeDetail: vi.fn(),
  getChainMembers: vi.fn(),
  createChainNode: vi.fn(),
  transitionChainNode: vi.fn(),
  openAssistant: vi.fn(),
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
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(mocks.query), mocks.setSearchParams],
}));
vi.mock("@plane/i18n", () => ({
  DEFAULT_LANGUAGE: "en",
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
vi.mock("@/hooks/store/use-ai-assistant", () => ({ useAIAssistant: () => ({ openWithLocal: mocks.openAssistant }) }));
vi.mock("@plane/ui", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...(await import("../../../../packages/ui/src/list-controls/list-controls")),
}));
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
vi.mock("@/components/research/chains/research-chain-task-panel", () => ({
  ResearchChainTaskPanel: ({ chainId, nodeId }: { chainId: string; nodeId: string }) => (
    <div data-testid="chain-task-panel" data-chain={chainId} data-node={nodeId}>
      task-panel
    </div>
  ),
}));
vi.mock("@/components/research/chains/research-agent-operations", () => ({
  ResearchAgentOperations: () => <div>agent-operation-review</div>,
}));
vi.mock("@/components/research/chains/research-paper-review-panel", () => ({
  ResearchPaperReviewPanel: ({
    chainId,
    nodeId,
    events,
  }: {
    chainId: string;
    nodeId: string;
    events: Array<{ event_id: string }>;
  }) => (
    <div
      data-testid="paper-review-panel"
      data-chain={chainId}
      data-node={nodeId}
      data-events={events.map((event) => event.event_id).join(",")}
    >
      paper-review-panel
    </div>
  ),
}));
vi.mock("@/services/research/integration.service", () => ({
  ResearchIntegrationService: class {
    getReferences = vi.fn().mockResolvedValue({ results: [] });
  },
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

it("renders member columns and keeps role selection accessible", async () => {
  const { ResearchChainDetail } = await import("@/components/research/chains/research-chain-detail");
  mocks.query = "tab=members";
  await act(async () => root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />));
  const headings = [...container.querySelectorAll("th")].map((heading) => heading.textContent);
  expect(headings).toEqual(["成员", "权限", "操作"]);
  const role = container.querySelector("select")!;
  expect(role.labels?.[0]?.textContent).toContain("权限");
  expect(role.value).toBe("15");
});

it("keeps historical operation review links on the exact selected node", async () => {
  const { ResearchChainDetail } = await import("@/components/research/chains/research-chain-detail");
  mocks.query = "tab=nodes&node=node-1&operation=historical-op";
  await act(async () => root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />));
  await act(async () => undefined);
  expect(container.textContent).toContain("agent-operation-review");
  expect(container.querySelector('a[href*="/mcp/"]')?.getAttribute("href")).toContain("operation=historical-op");
});

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

afterEach(async () => {
  await act(async () => root.unmount());
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
  await act(async () => undefined);

  expect(container.textContent).toContain("文献调研");
  expect(container.textContent).not.toContain("文献快照");
  expect(container.textContent).not.toContain("人类决策");
  expect(container.textContent).toContain("R2");
  expect(container.textContent).toContain("阶段节点");
  expect(container.textContent).toContain("记录");

  const clickCount = async (label: string) => {
    await act(async () => {
      [...container.querySelectorAll("button")].find((item) => item.textContent?.startsWith(label))?.click();
    });
  };
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="记录"]')?.click();
  });
  expect(container.textContent).toContain("证据");
  expect(container.textContent).toContain("输入");
  expect(container.textContent).toContain("人类决策");
  await clickCount("快照");
  expect(container.textContent).toContain("文献快照");
  await clickCount("过程记录");
  expect(container.textContent).toContain("创建节点");
  expect(container.querySelector("path[stroke-dasharray='4 4']")).toBeNull();
  expect(
    container.querySelector('a[href="/lab/research/chains/chain-1?tab=nodes"]')?.getAttribute("aria-current")
  ).toBe("page");
  expect(container.querySelector('button[aria-pressed="true"]')).not.toBeNull();
  expect([...container.querySelectorAll("nav a")].map((item) => item.textContent)).toEqual(["概览", "节点", "成员"]);
  const openAssistant = container.querySelector<HTMLButtonElement>('button[aria-label="请智能体分析"]');
  expect(openAssistant).not.toBeNull();
  await act(async () => openAssistant!.click());
  expect(mocks.openAssistant).toHaveBeenCalledWith("node-1");
  expect(container.textContent).toContain("MCP / Agent 操作");
  expect(container.querySelector('a[href*="/mcp/"]')?.getAttribute("href")).toContain("chain=chain-1&node=node-1");
  expect(container.textContent).not.toContain("agent-operation-review");
  expect(container.querySelector('[data-testid="chain-task-panel"]')?.getAttribute("data-node")).toBe("node-1");
  expect(container.querySelector('[data-testid="paper-review-panel"]')).toBeNull();
  expect(container.textContent).not.toContain("记录与知识库");
  expect(container.textContent).not.toContain("报告与成果");
  expect([...container.querySelectorAll("button")].map((item) => item.textContent)).not.toContain("实验记录");

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "开始")?.click();
  });
  expect(mocks.transitionChainNode).toHaveBeenCalledWith("lab", "node-1", "START", undefined);
});

it("mounts the paper review panel with selected node events for paper writing replay", async () => {
  const { ResearchChainDetail } = await import("@/components/research/chains/research-chain-detail");
  const paperNode = { ...node, node_type: "PAPER_WRITING", title: "论文撰写" };
  mocks.query = "tab=nodes&stage=paper_writing&node=node-1";
  mocks.getChainNodes.mockResolvedValue([paperNode]);
  mocks.getChainNodeDetail.mockResolvedValue({
    node: paperNode,
    events: [
      {
        event_id: "event-1",
        event_type: "NODE_CREATED",
        occurred_at: "2026-10-10T08:00:00Z",
        refs: [],
        summary: "创建论文写作节点",
      },
    ],
    snapshots: [],
  });

  await act(async () => {
    root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />);
  });
  await act(async () => undefined);

  const taskPanel = container.querySelector('[data-testid="chain-task-panel"]');
  const reviewPanel = container.querySelector('[data-testid="paper-review-panel"]');
  expect(taskPanel?.getAttribute("data-chain")).toBe("chain-1");
  expect(taskPanel?.getAttribute("data-node")).toBe("node-1");
  expect(reviewPanel?.getAttribute("data-chain")).toBe("chain-1");
  expect(reviewPanel?.getAttribute("data-node")).toBe("node-1");
  expect(reviewPanel?.getAttribute("data-events")).toBe("event-1");
  expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("论文写作");
});

it("shows the scoped knowledge upload below the selected node tasks", async () => {
  mocks.query = "tab=references&node=node-1";
  const { ResearchChainDetail } = await import("@/components/research/chains/research-chain-detail");
  await act(async () => {
    root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />);
  });
  await act(async () => undefined);

  const panel = container.querySelector('[data-testid="chain-knowledge-panel"]');
  expect(panel?.getAttribute("data-chain")).toBe("chain-1");
  expect(panel?.getAttribute("data-node")).toBe("node-1");
  expect(container.querySelectorAll("nav a").length).toBe(3);
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
  expect(container.textContent).not.toContain("快照");
  expect(container.textContent).not.toContain("文献快照");
  await act(async () => {
    [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("记录"))?.click();
  });
  await act(async () => {
    [...container.querySelectorAll("button")].find((item) => item.textContent?.startsWith("快照"))?.click();
  });
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

it("creates a titled node from the stage plus without exposing a node type selector", async () => {
  const { ResearchChainDetail } = await import("@/components/research/chains/research-chain-detail");
  mocks.createChainNode.mockRejectedValueOnce(new Error("invalid type"));
  await act(async () => {
    root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />);
  });

  const createTrigger = container.querySelector<HTMLButtonElement>('button[aria-label="创建研究节点"]');
  expect(createTrigger).not.toBeNull();
  await act(async () => createTrigger?.click());
  expect(container.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
  const titleInput = container.querySelector('input[placeholder="文献调研、实验或分析"]');
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    if (titleInput instanceof HTMLInputElement) {
      valueSetter?.call(titleInput, "新节点");
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    [...container.querySelectorAll("button")].find((button) => button.textContent === "创建节点")?.click();
  });

  expect(mocks.createChainNode).toHaveBeenCalledWith("lab", "chain-1", {
    node_type: "LITERATURE_REVIEW",
    title: "新节点",
    parent_node_id: "node-1",
    loop_iteration: 1,
  });
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

it("aliases the old material tabs and explains an empty draft snapshot", async () => {
  const { ResearchChainDetail, resolveChainTab } = await import("@/components/research/chains/research-chain-detail");
  expect(resolveChainTab("references")).toBe("nodes");
  expect(resolveChainTab("reports")).toBe("nodes");
  expect(resolveChainTab("experiments")).toBe("nodes");
  expect(resolveChainTab("replay")).toBe("nodes");
  expect(resolveChainTab(null)).toBe("overview");
  expect(resolveChainTab("")).toBe("overview");

  mocks.getChainNodeDetail.mockResolvedValueOnce({ node, events: [], snapshots: [] });
  await act(async () => {
    root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />);
  });
  await act(async () => undefined);

  expect(container.textContent).not.toContain("空项");
  expect(container.textContent).not.toContain("提交并确认本节点后生成版本，不能单独上传。");
  await act(async () => {
    [...container.querySelectorAll("button")].find((item) => item.textContent?.includes("记录"))?.click();
  });
  expect(container.textContent).toContain("空项");
  await act(async () => {
    [...container.querySelectorAll("button")].find((item) => item.textContent?.startsWith("快照"))?.click();
  });
  expect(container.textContent).toContain("提交并确认本节点后生成版本，不能单独上传。");
  expect(container.textContent).not.toContain("该阶段暂无已确认快照");
});

it("removes the topic materials tab and redirects legacy links to the node workspace", async () => {
  const { ResearchChainDetail } = await import("@/components/research/chains/research-chain-detail");
  mocks.query = "tab=materials";
  await act(async () => {
    root.render(<ResearchChainDetail workspaceSlug="lab" chainId="chain-1" />);
  });
  await act(async () => undefined);

  expect(container.querySelector('[data-testid="chain-knowledge-panel"]')?.getAttribute("data-node")).toBe("node-1");
  expect(container.textContent).not.toContain("experiment-list");
  expect(container.querySelectorAll("nav a").length).toBe(3);
  expect(
    [...container.querySelectorAll("nav a")]
      .find((item) => item.textContent === "课题资料")
      ?.getAttribute("aria-current")
  ).toBeUndefined();
});
