/** 使用隔离数据检查科研链阶段审批面板的排版与交互。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { setLanguage, TranslationProvider } from "@plane/i18n";
import type { TResearchChainStageApproval } from "@plane/types";

import { ResearchChainStageApprovalPanel } from "@/components/research/chains/research-chain-stage-approval-panel";
import { ResearchChainService } from "@/services/research/chain.service";
// oxlint-disable-next-line import/no-unassigned-import -- 使用实际页面样式验证布局。
import "./research-home-workbench.fixture.css";

/** 生成隔离验收使用的权限决策。 */
const decision = (allowed: boolean) => ({ allowed, reason_code: "fixture", reason: "隔离测试" });

const stage: TResearchChainStageApproval = {
  schema_version: "research-chain-stage.v1",
  id: "stage-experiment",
  chain: "fixture-chain",
  stage_code: "EXPERIMENT",
  sort_order: 7,
  status: "IN_PROGRESS",
  pi_policy: "CONDITIONAL_PI",
  requires_pi: false,
  escalation_reason: "",
  attempt_count: 1,
  submitted_node: null,
  submitted_at: null,
  approved_at: null,
  materials: [
    {
      id: "material-plan",
      code: "FORMAL_EXPERIMENT_PLAN",
      title: "正式实验方案",
      minimum_count: 1,
      submitted_count: 1,
      complete: true,
      items: [
        {
          id: "item-plan",
          title: "动物模型给药方案 v2",
          description: "",
          source_node: "fixture-node",
          external_reference: "",
          created_at: "2026-10-22T01:00:00Z",
        },
      ],
    },
    {
      id: "material-sop",
      code: "SOP",
      title: "SOP",
      minimum_count: 1,
      submitted_count: 0,
      complete: false,
      items: [],
    },
  ],
  review_actions: [
    {
      schema_version: "research-chain-stage-review-action.v1",
      id: "action-return",
      attempt_no: 1,
      reviewer_role: "ADVISOR",
      reviewer_detail: { id: "advisor", display_name: "直接导师", email: "advisor@example.com" },
      action: "RETURN",
      comment: "请补充标准操作流程后重新提交。",
      escalated_to_pi: false,
      material_snapshot: [],
      declaration_snapshot: {},
      created_at: "2026-10-21T01:00:00Z",
    },
  ],
  latest_precheck: null,
  advisor: { user: { id: "advisor", display_name: "直接导师", email: "advisor@example.com" }, error: null },
  principal_investigator: {
    user: { id: "pi", display_name: "主 PI", email: "pi@example.com" },
    error: null,
  },
  current_review_step: null,
  capabilities: {
    schema_version: "research-capabilities.v1",
    actions: {
      edit_materials: decision(true),
      remove_material: decision(true),
      precheck: decision(false),
      submit: decision(true),
      review: decision(false),
    },
  },
  created_at: "2026-10-20T01:00:00Z",
  updated_at: "2026-10-22T01:00:00Z",
};

const nodes = [
  {
    schema_version: "research-node.v1",
    id: "fixture-node",
    chain: "fixture-chain",
    node_type: "EXPERIMENT",
    title: "正式实验",
    parent_node: null,
    loop_iteration: 0,
    status: "ACTIVE",
    assignee: null,
    created_at: "2026-10-20T01:00:00Z",
    updated_at: "2026-10-22T01:00:00Z",
  },
];

ResearchChainService.prototype.createChainStageMaterial = async () => undefined;
ResearchChainService.prototype.deleteChainStageMaterial = async () => undefined;
ResearchChainService.prototype.submitChainStage = async () => stage;

await setLanguage("zh-CN");
document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(
  <TranslationProvider>
    <main className="min-h-screen bg-canvas p-6">
      <section className="mx-auto max-w-5xl overflow-hidden rounded-lg border border-subtle bg-surface-1">
        <ResearchChainStageApprovalPanel
          workspaceSlug="fixture-workspace"
          chainId="fixture-chain"
          stage={stage}
          nodes={nodes}
          preferredNodeId="fixture-node"
          onChanged={() => undefined}
        />
      </section>
    </main>
  </TranslationProvider>
);
