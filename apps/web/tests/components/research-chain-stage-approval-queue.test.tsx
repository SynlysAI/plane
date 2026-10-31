// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TResearchChainStageApproval } from "@plane/types";

const mocks = vi.hoisted(() => ({
  canSeeOrg: false,
  getChain: vi.fn(),
  getChainNodes: vi.fn(),
  getChainStageApprovals: vi.fn(),
  onHandled: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      key === "research.todo.queue_position" ? `第 ${params?.index ?? 0} 项 / 共 ${params?.count ?? 0} 项` : key,
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    getChain = mocks.getChain;
    getChainNodes = mocks.getChainNodes;
    getChainStageApprovals = mocks.getChainStageApprovals;
  },
}));
vi.mock("@/components/research/chains/research-chain-stage-approval-panel", () => ({
  ResearchChainStageApprovalPanel: (props: {
    stage: TResearchChainStageApproval;
    canManageOrgUnit?: boolean;
    onDecision?: (stage: TResearchChainStageApproval) => Promise<void> | void;
  }) => (
    <div>
      <span>{props.stage.id}</span>
      <span>{props.canManageOrgUnit ? "can-manage-org" : "cannot-manage-org"}</span>
      <button type="button" onClick={() => void props.onDecision?.(props.stage)}>
        mock decision
      </button>
    </div>
  ),
}));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({ canSee: (section: string) => section === "org" && mocks.canSeeOrg }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { ResearchChainStageApprovalQueue } =
  await import("@/components/research/approvals/research-chain-stage-approval-queue");

type QueueItem = Parameters<typeof ResearchChainStageApprovalQueue>[0]["items"][number];

/** 构造一条阶段审批队列项。 */
function item(id: string, chainId: string, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: `research:CHAIN_STAGE_APPROVAL:${id}`,
    object_id: id,
    title: `阶段 ${id}`,
    href: `/lab/research/chains/${chainId}?tab=nodes&stage=${id}&approval=1`,
    context: "科研链阶段审批 · ADVISOR",
    requester: { id: "student", display_name: "学生" },
    ...overrides,
  };
}

/** 构造最小阶段审批对象。 */
function stage(id: string, chainId: string) {
  return { id, chain: chainId } as TResearchChainStageApproval;
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getChain.mockResolvedValue({ id: "chain-1", owner_name: "学生" });
  mocks.getChainNodes.mockResolvedValue([]);
  mocks.getChainStageApprovals.mockResolvedValue({ stages: [stage("stage-1", "chain-1")] });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

/** 渲染阶段审批队列。 */
async function renderQueue(items: QueueItem[], activeId: string) {
  await act(async () => {
    root.render(
      <ResearchChainStageApprovalQueue
        workspaceSlug="lab"
        items={items}
        activeId={activeId}
        onHandled={mocks.onHandled}
        onClose={mocks.onClose}
      />
    );
  });
  await act(async () => undefined);
}

it("loads only the selected stage and reports a successful decision", async () => {
  mocks.canSeeOrg = true;
  await renderQueue([item("stage-1", "chain-1"), item("stage-2", "chain-2")], "research:CHAIN_STAGE_APPROVAL:stage-1");

  expect(container.textContent).toContain("第 1 项 / 共 2 项");
  expect(container.textContent).toContain("stage-1");
  expect(container.textContent).toContain("can-manage-org");

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "mock decision")?.click();
  });

  expect(mocks.onHandled).toHaveBeenCalledWith("research:CHAIN_STAGE_APPROVAL:stage-1");
});

it("shows the original deep link and retry when queue context cannot load", async () => {
  mocks.getChainStageApprovals.mockResolvedValue({ stages: [] });
  await renderQueue([item("stage-1", "chain-1")], "research:CHAIN_STAGE_APPROVAL:stage-1");

  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector('a[href^="/lab/research/chains/chain-1?"]')).not.toBeNull();
});
