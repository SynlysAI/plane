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
    title: "选题评估",
    parent_node: null,
    loop_iteration: 0,
    status: "ACTIVE",
    assignee: null,
    created_at: "2026-10-22T01:00:00Z",
    updated_at: "2026-10-22T01:00:00Z",
  },
];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onChanged = vi.fn();

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

function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label
  );
}

it("disables submission while hard materials are incomplete and can run precheck", async () => {
  mocks.runChainStagePrecheck.mockResolvedValue({});
  await act(async () => {
    root.render(
      <ResearchChainStageApprovalPanel
        workspaceSlug="lab"
        chainId="chain-1"
        stage={stage({})}
        nodes={nodes}
        preferredNodeId="node-1"
        onChanged={onChanged}
      />
    );
  });

  expect(container.textContent).toContain("已提交 0/1");
  expect(container.textContent).toContain("还有 1 项材料未满足要求");
  expect(button("提交阶段审核")?.disabled).toBe(true);

  await act(async () => button("生成 AI 预检")?.click());
  expect(mocks.runChainStagePrecheck).toHaveBeenCalledWith("lab", "chain-1", "TOPIC_EVALUATION");
});

it("requires an explicit advisor decision before conditional PI escalation", async () => {
  mocks.reviewChainStage.mockResolvedValue({});
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
  await act(async () => {
    root.render(
      <ResearchChainStageApprovalPanel
        workspaceSlug="lab"
        chainId="chain-1"
        stage={conditional}
        nodes={nodes}
        preferredNodeId="node-1"
        onChanged={onChanged}
      />
    );
  });

  expect(button("通过并转主 PI")).not.toBeNull();
  expect(button("导师通过，不转 PI")).not.toBeNull();
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
