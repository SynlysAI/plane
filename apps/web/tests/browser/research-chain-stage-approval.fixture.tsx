/** 使用隔离数据检查科研链阶段审批面板的排版与交互。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { setLanguage, TranslationProvider } from "@plane/i18n";
import type { TResearchChainNode, TResearchChainStageApproval } from "@plane/types";

import { ResearchChainStageApprovalPanel } from "@/components/research/chains/research-chain-stage-approval-panel";
import { useResearchChainKnowledge } from "@/components/research/chains/use-research-chain-knowledge";
import { ResearchChainService } from "@/services/research/chain.service";
// oxlint-disable-next-line import/no-unassigned-import -- 使用实际页面样式验证布局。
import "./research-home-workbench.fixture.css";

/** 生成隔离验收使用的权限决策。 */
const decision = (allowed: boolean) => ({ allowed, reason_code: "fixture", reason: "隔离测试" });

const fixtureUpload = {
  id: "fixture-upload",
  status: "PROCESSING" as const,
  knowledge_id: "fixture-knowledge",
  knowledge_base_id: "fixture-kb",
  file_name: "formal-experiment-plan.pdf",
  file_type: "pdf",
  file_size: 5.1 * 1024 * 1024,
  preview_url: "/fixture-preview/",
  download_url: "/fixture-download/",
  error_code: "",
};

/** 生成一个浏览器验收使用的阶段节点。 */
function fixtureNode(id: string, type: string, title: string): TResearchChainNode {
  return {
    schema_version: "research-node.v1",
    id,
    chain: "fixture-chain",
    node_type: type,
    title,
    parent_node: null,
    loop_iteration: 0,
    status: "ACTIVE",
    assignee: null,
    created_at: "2026-10-20T01:00:00Z",
    updated_at: "2026-10-22T01:00:00Z",
  };
}

/** 生成一个完整材料要求。 */
function completeMaterial(id: string, code: string, title: string) {
  return {
    id,
    code,
    title,
    minimum_count: 1,
    submitted_count: 1,
    complete: true,
    items: [
      {
        id: `${id}-item`,
        title: `${title} v1`,
        description: "",
        source_node: "fixture-node",
        upload: fixtureUpload.id,
        upload_detail: {
          id: fixtureUpload.id,
          status: fixtureUpload.status,
          file_name: fixtureUpload.file_name,
          file_size: fixtureUpload.file_size,
          preview_url: fixtureUpload.preview_url,
          download_url: fixtureUpload.download_url,
          error_code: fixtureUpload.error_code,
        },
        external_reference: "",
        created_at: "2026-10-22T01:00:00Z",
      },
    ],
  };
}

/** 生成一个缺失材料要求。 */
function missingMaterial(id: string, code: string, title: string) {
  return {
    id,
    code,
    title,
    minimum_count: 1,
    submitted_count: 0,
    complete: false,
    items: [],
  };
}

/** 生成阶段审批隔离夹具。 */
function baseStage(seed: Partial<TResearchChainStageApproval>): TResearchChainStageApproval {
  return {
    schema_version: "research-chain-stage.v1",
    id: "stage-fixture",
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
    materials: [],
    review_actions: [
      {
        schema_version: "research-chain-stage-review-action.v1",
        id: "action-return",
        attempt_no: 1,
        reviewer_role: "ADVISOR",
        reviewer_detail: { id: "advisor", display_name: "直接导师", email: "advisor@example.com" },
        action: "RETURN",
        comment: "请补充标准操作流程后重新提交。\n第二行仅展开历史时显示。",
        escalated_to_pi: false,
        material_snapshot: [{ code: "SOP", titles: ["旧版 SOP"] }],
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
    ...seed,
  };
}

const scenarios: Record<string, { label: string; stage: TResearchChainStageApproval; nodes: TResearchChainNode[] }> = {
  missing: {
    label: "缺材料 / 条件转 PI / 历史",
    stage: baseStage({
      materials: [
        completeMaterial("material-plan", "FORMAL_EXPERIMENT_PLAN", "正式实验方案"),
        missingMaterial("material-sop", "SOP", "SOP"),
      ],
    }),
    nodes: [fixtureNode("fixture-node", "EXPERIMENT", "正式实验")],
  },
  "no-node": {
    label: "无业务节点",
    stage: baseStage({
      id: "stage-topic",
      stage_code: "TOPIC_SELECTION",
      sort_order: 2,
      pi_policy: "ADVISOR_ONLY",
      status: "NOT_STARTED",
      attempt_count: 0,
      review_actions: [],
      materials: [
        missingMaterial("material-title", "TOPIC_TITLE", "题目"),
        missingMaterial("material-question", "RESEARCH_QUESTION", "研究问题"),
      ],
    }),
    nodes: [],
  },
  "needs-revision": {
    label: "需修改 / 退回意见",
    stage: baseStage({
      status: "NEEDS_REVISION",
      materials: [
        completeMaterial("material-plan", "FORMAL_EXPERIMENT_PLAN", "正式实验方案"),
        missingMaterial("material-sop", "SOP", "SOP"),
      ],
    }),
    nodes: [fixtureNode("fixture-node", "EXPERIMENT", "正式实验")],
  },
  "precheck-expired": {
    label: "阶段 03 预检过期",
    stage: baseStage({
      id: "stage-topic-evaluation",
      stage_code: "TOPIC_EVALUATION",
      sort_order: 3,
      pi_policy: "ALWAYS_PI",
      materials: [
        completeMaterial("material-feasibility", "PRINCIPLE_FEASIBILITY", "原理可行性分析"),
        completeMaterial("material-lab", "LAB_CONDITIONS", "实验室条件"),
      ],
      latest_precheck: {
        schema_version: "research-chain-stage-precheck.v1",
        id: "precheck-old",
        status: "READY",
        summary: "旧版本材料完整。",
        material_version: "old-version",
        is_current: false,
        checks: [
          { code: "PRINCIPLE_FEASIBILITY", passed: true, submitted_count: 1, minimum_count: 1 },
          { code: "LAB_CONDITIONS", passed: true, submitted_count: 1, minimum_count: 1 },
        ],
        recommendations: [],
        generated_by: "research-agent-precheck",
        model_version: "rule-material-v1",
        created_at: "2026-10-21T01:00:00Z",
      },
      capabilities: {
        schema_version: "research-capabilities.v1",
        actions: {
          edit_materials: decision(true),
          remove_material: decision(true),
          precheck: decision(true),
          submit: decision(true),
          review: decision(false),
        },
      },
    }),
    nodes: [fixtureNode("fixture-node", "TOPIC_EVALUATION", "选题评估")],
  },
  "awaiting-advisor": {
    label: "待直接导师审核",
    stage: baseStage({
      status: "AWAITING_ADVISOR",
      current_review_step: "ADVISOR",
      requires_pi: true,
      escalation_reason: "正式实验涉及高价值样本。",
      submitted_node: "fixture-node",
      materials: [
        completeMaterial("material-plan", "FORMAL_EXPERIMENT_PLAN", "正式实验方案"),
        completeMaterial("material-sop", "SOP", "SOP"),
      ],
      capabilities: {
        schema_version: "research-capabilities.v1",
        actions: {
          edit_materials: decision(false),
          remove_material: decision(false),
          precheck: decision(false),
          submit: decision(false),
          review: decision(true),
        },
      },
    }),
    nodes: [fixtureNode("fixture-node", "EXPERIMENT", "正式实验")],
  },
  "awaiting-pi": {
    label: "待主 PI 审核",
    stage: baseStage({
      id: "stage-summary",
      stage_code: "SUMMARY",
      sort_order: 10,
      status: "AWAITING_PI",
      pi_policy: "ALWAYS_PI",
      current_review_step: "PI",
      attempt_count: 2,
      submitted_node: "fixture-node",
      materials: [completeMaterial("material-result", "MAIN_RESULTS", "主要结果")],
      capabilities: {
        schema_version: "research-capabilities.v1",
        actions: {
          edit_materials: decision(false),
          remove_material: decision(false),
          precheck: decision(false),
          submit: decision(false),
          review: decision(true),
        },
      },
    }),
    nodes: [fixtureNode("fixture-node", "SUMMARY", "课题总结")],
  },
};

const scenarioName = new URLSearchParams(window.location.search).get("scenario") ?? "missing";
const scenario = scenarios[scenarioName] ?? scenarios.missing;

/** 用共享资料控制器渲染阶段面板，验证上传与关联的真实数据流。 */
function StageApprovalFixture() {
  const knowledge = useResearchChainKnowledge("fixture-workspace", "fixture-chain", "fixture-node");
  return (
    <ResearchChainStageApprovalPanel
      workspaceSlug="fixture-workspace"
      chainId="fixture-chain"
      stage={scenario.stage}
      nodes={scenario.nodes}
      preferredNodeId={scenario.nodes[0]?.id ?? null}
      applicantName="研究负责人"
      defaultExpanded={new URLSearchParams(window.location.search).get("expanded") === "1"}
      knowledge={knowledge}
      onCreateNode={() => undefined}
      onChanged={() => undefined}
    />
  );
}

ResearchChainService.prototype.createChainStageMaterial = async () => undefined;
ResearchChainService.prototype.deleteChainStageMaterial = async () => undefined;
ResearchChainService.prototype.getKnowledgeBases = async () => ({
  items: [{ external_id: fixtureUpload.knowledge_base_id, title: "器件小组共享库" }],
  degraded: false,
  degraded_reason: "",
  state: "READY" as const,
  request_id: "",
  scope: "GROUP" as const,
  orgUnitId: "fixture-team",
  orgUnitName: "器件小组",
  connectionStatus: "connected" as const,
  candidates: [],
});
ResearchChainService.prototype.getKnowledgeUploads = async () => ({ data: [fixtureUpload] });
ResearchChainService.prototype.getKnowledgeUpload = async () => ({
  data: fixtureUpload,
  degraded: false,
});
ResearchChainService.prototype.uploadKnowledgeFile = async () => ({
  data: { ...fixtureUpload, id: "fixture-new-upload" },
  degraded: false,
});
ResearchChainService.prototype.runChainStagePrecheck = async () => undefined;
ResearchChainService.prototype.submitChainStage = async () => scenario.stage;
ResearchChainService.prototype.reviewChainStage = async () => scenario.stage;

await setLanguage("zh-CN");
document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(
  <TranslationProvider>
    <main className="min-h-screen bg-canvas p-6">
      <section className="mx-auto max-w-5xl overflow-hidden rounded-lg border border-subtle bg-surface-1">
        <p className="border-b border-subtle px-4 py-2 text-11 text-tertiary">{scenario.label}</p>
        <StageApprovalFixture />
      </section>
    </main>
  </TranslationProvider>
);
