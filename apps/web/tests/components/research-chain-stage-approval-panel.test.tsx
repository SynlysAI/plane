// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  createChainStageMaterial: vi.fn(),
  deleteChainStageMaterial: vi.fn(),
  runChainStagePrecheck: vi.fn(),
  submitChainStage: vi.fn(),
  reviewChainStage: vi.fn(),
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
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    createChainStageMaterial = mocks.createChainStageMaterial;
    deleteChainStageMaterial = mocks.deleteChainStageMaterial;
    runChainStagePrecheck = mocks.runChainStagePrecheck;
    submitChainStage = mocks.submitChainStage;
    reviewChainStage = mocks.reviewChainStage;
  },
}));

const { ResearchChainStageApprovalPanel } =
  await import("@/components/research/chains/research-chain-stage-approval-panel");

function capability(action: string, allowed = false) {
  return {
    allowed,
    reason_code: allowed ? "allowed" : "research_permission_denied",
    reason: allowed ? "允许操作" : "当前身份无权执行此操作",
  };
}

function stage(seed: Record<string, unknown>) {
  return {
    schema_version: "research-chain-stage.v1",
    id: "stage-1",
    chain: "chain-1",
    stage_code: "TOPIC_EVALUATION",
    sort_order: 3,
    status: "IN_PROGRESS",
    pi_policy: "ALWAYS_PI",
    requires_pi: false,
    escalation_reason: "",
    attempt_count: 0,
    submitted_node: null,
    submitted_at: null,
    approved_at: null,
    materials: [
      {
        id: "material-1",
        code: "PRINCIPLE_FEASIBILITY",
        title: "原理可行性分析",
        minimum_count: 1,
        submitted_count: 0,
        complete: false,
        items: [],
      },
    ],
    review_actions: [],
    latest_precheck: null,
    advisor: { user: { id: "advisor", display_name: "直接导师", email: "a@example.com" }, error: null },
    principal_investigator: { user: null, error: null },
    current_review_step: null,
    capabilities: {
      schema_version: "research-capabilities.v1",
      actions: {
        edit_materials: capability("edit_materials", true),
        remove_material: capability("remove_material"),
        precheck: capability("precheck", true),
        submit: capability("submit", true),
        review: capability("review"),
      },
    },
    created_at: "2026-10-22T01:00:00Z",
    updated_at: "2026-10-22T01:00:00Z",
    ...seed,
  };
}

const nodes = [
  {
    schema_version: "research-node.v1",
    id: "node-1",
    chain: "chain-1",
    node_type: "TOPIC_EVALUATION",
    title: "可提交节点",
    parent_node: null,
    loop_iteration: 0,
    status: "ACTIVE",
    assignee: null,
    created_at: "2026-10-22T01:00:00Z",
    updated_at: "2026-10-22T01:00:00Z",
  },
  {
    schema_version: "research-node.v1",
    id: "node-2",
    chain: "chain-1",
    node_type: "TOPIC_EVALUATION",
    title: "已完成节点",
    parent_node: null,
    loop_iteration: 0,
    status: "COMPLETED",
    assignee: null,
    created_at: "2026-10-22T01:00:00Z",
    updated_at: "2026-10-22T01:00:00Z",
  },
];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onChanged = vi.fn();
const onCreateNode = vi.fn();

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

async function renderPanel(
  options: { stage?: ReturnType<typeof stage>; nodes?: typeof nodes; expanded?: boolean } = {}
) {
  await act(async () => {
    root.render(
      <ResearchChainStageApprovalPanel
        workspaceSlug="lab"
        chainId="chain-1"
        stage={options.stage ?? stage({})}
        nodes={options.nodes ?? nodes}
        preferredNodeId="node-1"
        applicantName="研究负责人"
        defaultExpanded={options.expanded ?? false}
        onCreateNode={onCreateNode}
        onChanged={onChanged}
      />
    );
  });
}

function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label
  );
}

async function expand() {
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button[aria-expanded]")?.click();
  });
}

it("keeps the panel collapsed with a high-signal summary by default", async () => {
  await renderPanel();

  const disclosure = container.querySelector<HTMLButtonElement>("button[aria-expanded]");
  expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
  expect(disclosure?.getAttribute("aria-controls")).toBe("stage-1-stage-approval-content");
  expect(disclosure?.textContent).toContain("进行中");
  expect(disclosure?.textContent).toContain("材料 0/1");
  expect(disclosure?.textContent).toContain("待提交");
  expect(container.textContent).not.toContain("原理可行性分析");

  await expand();
  expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("原理可行性分析");
});

it("opens automatically from an approval-center deep link", async () => {
  await renderPanel({ expanded: true });

  expect(container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
  expect(container.textContent).toContain("原理可行性分析");
});

it("shows the first missing material nearby and parses backend missing names", async () => {
  mocks.createChainStageMaterial.mockRejectedValue({
    error_code: "research_chain_stage_material_incomplete",
    message: "All required stage materials must be submitted.",
    missing: ["PRINCIPLE_FEASIBILITY"],
  });
  await renderPanel({ expanded: true });

  expect(button("补充")).not.toBeNull();
  const title = [...container.querySelectorAll<HTMLInputElement>("input")].find((input) =>
    input.getAttribute("placeholder")?.includes("原理可行性分析")
  );
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(title, "可行性说明");
    title?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("添加材料")?.click());

  expect(mocks.createChainStageMaterial).toHaveBeenCalled();
  expect(container.querySelector("[role='alert']")?.textContent).toContain("缺少材料：原理可行性分析");
});

it("offers node creation when the stage has no business node", async () => {
  await renderPanel({ nodes: [], expanded: true });

  expect(container.textContent).toContain("尚无阶段业务节点");
  expect(button("创建阶段节点")?.disabled).toBe(false);
  await act(async () => button("创建阶段节点")?.click());
  expect(onCreateNode).toHaveBeenCalledTimes(1);
});

it("only lists nodes the backend allows for submission", async () => {
  await renderPanel({ expanded: true });

  const select = container.querySelector<HTMLSelectElement>('select[aria-label="提交节点"]');
  expect([...(select?.options ?? [])].map((option) => option.text)).toEqual(["可提交节点"]);
});

it("marks an outdated stage-three precheck and blocks submission", async () => {
  const outdated = stage({
    latest_precheck: {
      schema_version: "research-chain-stage-precheck.v1",
      id: "precheck-1",
      status: "READY",
      summary: "材料完整性预检通过。",
      material_version: "old-version",
      is_current: false,
      checks: [{ code: "PRINCIPLE_FEASIBILITY", passed: true, submitted_count: 1, minimum_count: 1 }],
      recommendations: [],
      generated_by: "research-agent-precheck",
      model_version: "rule-material-v1",
      created_at: "2026-10-22T01:00:00Z",
    },
    materials: [
      {
        id: "material-1",
        code: "PRINCIPLE_FEASIBILITY",
        title: "原理可行性分析",
        minimum_count: 1,
        submitted_count: 1,
        complete: true,
        items: [
          {
            id: "item-1",
            title: "可行性说明",
            description: "",
            source_node: null,
            external_reference: "",
            created_at: "2026-10-22T01:00:00Z",
          },
        ],
      },
    ],
  });
  mocks.runChainStagePrecheck.mockResolvedValue({});
  await renderPanel({ stage: outdated, expanded: true });

  expect(container.textContent).toContain("结果已过期，需重新检查");
  expect(button("提交阶段审核")?.disabled).toBe(true);
  await act(async () => button("重新检查")?.click());
  expect(mocks.runChainStagePrecheck).toHaveBeenCalledWith("lab", "chain-1", "TOPIC_EVALUATION");
});

it("keeps only one advisor approve action when PI review was declared", async () => {
  const conditional = stage({
    stage_code: "EXPERIMENT",
    status: "AWAITING_ADVISOR",
    pi_policy: "CONDITIONAL_PI",
    requires_pi: true,
    escalation_reason: "正式启动",
    current_review_step: "ADVISOR",
    capabilities: {
      schema_version: "research-capabilities.v1",
      actions: {
        edit_materials: capability("edit_materials"),
        remove_material: capability("remove_material"),
        precheck: capability("precheck"),
        submit: capability("submit"),
        review: capability("review", true),
      },
    },
  });
  mocks.reviewChainStage.mockResolvedValue({});
  await renderPanel({ stage: conditional, nodes: [], expanded: true });

  expect(container.textContent).toContain("申请人: 研究负责人");
  expect(button("通过并转主 PI")).not.toBeNull();
  expect(button("导师通过，不转 PI")).toBeUndefined();
  expect(button("驳回")?.disabled).toBe(true);

  const textarea = container.querySelector("textarea")!;
  const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    valueSetter?.call(textarea, "同意启动");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("通过并转主 PI")?.click());

  expect(mocks.reviewChainStage).toHaveBeenCalledWith("lab", "chain-1", "EXPERIMENT", {
    action: "APPROVE",
    comment: "同意启动",
    escalate_to_pi: true,
  });
});

it("keeps review history collapsed until requested", async () => {
  const reviewed = stage({
    review_actions: [
      {
        schema_version: "research-chain-stage-review-action.v1",
        id: "review-1",
        attempt_no: 1,
        reviewer_role: "ADVISOR",
        reviewer_detail: { id: "advisor", display_name: "直接导师", email: "a@example.com" },
        action: "RETURN",
        comment: "补充实验边界",
        escalated_to_pi: false,
        material_snapshot: [],
        declaration_snapshot: {},
        created_at: "2026-10-22T01:00:00Z",
      },
    ],
  });
  await renderPanel({ stage: reviewed, expanded: true });

  expect(container.textContent).toContain("历史审核 1 次");
  expect(container.textContent).not.toContain("补充实验边界");
  await act(async () => button("历史审核 1 次")?.click());
  expect(container.textContent).toContain("直接导师");
  expect(container.textContent).toContain("补充实验边界");
});
