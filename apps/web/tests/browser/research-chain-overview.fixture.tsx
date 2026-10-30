/** 使用隔离数据检查科研链概览指挥台的信息聚合与操作前移。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { setLanguage, TranslationProvider } from "@plane/i18n";
import type {
  TResearchChain,
  TResearchChainEvent,
  TResearchChainMember,
  TResearchChainNode,
  TResearchChainNodeTask,
  TResearchChainStageApproval,
  TResearchChainStageApprovalSummary,
} from "@plane/types";

import { ResearchChainOverviewCommand } from "@/components/research/chains/research-chain-overview-command";
import { buildResearchWorkflow } from "@/components/research/chains/research-chain-workflow";
import { ResearchChainService } from "@/services/research/chain.service";
import { ResearchChainTaskService } from "@/services/research/chain-task.service";
// oxlint-disable-next-line import/no-unassigned-import -- 使用实际页面样式验证布局。
import "./research-home-workbench.fixture.css";

/** 生成隔离验收使用的权限决策。 */
const decision = (allowed: boolean) => ({ allowed, reason_code: "fixture", reason: "隔离测试" });

/** 生成浏览器验收使用的业务节点。 */
function fixtureNode(
  id: string,
  type: string,
  title: string,
  status: TResearchChainNode["status"]
): TResearchChainNode {
  return {
    schema_version: "research-node.v1",
    id,
    chain: "fixture-chain",
    node_type: type,
    title,
    parent_node: null,
    loop_iteration: 0,
    status,
    assignee: null,
    created_at: "2026-10-20T01:00:00Z",
    updated_at: "2026-10-27T01:00:00Z",
  };
}

/** 生成一份完整的阶段材料要求。 */
function completeMaterial(id: string, code: string, title: string) {
  return {
    id,
    code,
    title,
    minimum_count: 1,
    submitted_count: 1,
    complete: true,
    submission_state: "READY",
    processing_count: 0,
    failed_count: 0,
    items: [
      {
        id: `${id}-item`,
        title: `${title} v1`,
        description: "",
        source_node: null,
        upload: null,
        upload_detail: null,
        external_reference: "",
        created_at: "2026-10-26T01:00:00Z",
      },
    ],
  };
}

/** 生成一份缺失的阶段材料要求。 */
function missingMaterial(id: string, code: string, title: string) {
  return {
    id,
    code,
    title,
    minimum_count: 1,
    submitted_count: 0,
    complete: false,
    submission_state: "INCOMPLETE",
    processing_count: 0,
    failed_count: 0,
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
        comment: "请补充标准操作流程后重新提交。",
        escalated_to_pi: false,
        material_snapshot: [],
        declaration_snapshot: {},
        created_at: "2026-10-25T01:00:00Z",
      },
    ],
    latest_precheck: null,
    advisor: { user: { id: "advisor", display_name: "直接导师", email: "advisor@example.com" }, error: null },
    principal_investigator: { user: { id: "pi", display_name: "主 PI", email: "pi@example.com" }, error: null },
    current_review_step: null,
    capabilities: {
      schema_version: "research-capabilities.v1",
      actions: {
        edit_materials: decision(true),
        submit: decision(true),
        review: decision(false),
      },
    },
    created_at: "2026-10-20T01:00:00Z",
    updated_at: "2026-10-27T01:00:00Z",
    ...seed,
  };
}

const approvedLiterature = baseStage({
  id: "stage-literature",
  stage_code: "LITERATURE_REVIEW",
  sort_order: 1,
  status: "APPROVED",
  materials: [completeMaterial("material-lit", "DIRECT_ORIGINAL_STUDIES", "直接相关原创研究")],
  capabilities: {
    schema_version: "research-capabilities.v1",
    actions: { edit_materials: decision(false), submit: decision(false), review: decision(false) },
  },
});

const fixtureChain: TResearchChain = {
  schema_version: "research-chain.v1",
  id: "fixture-chain",
  project: "fixture-project",
  project_name: "钙钛矿器件稳定性研究",
  workspace: "fixture-workspace",
  owner: "owner",
  owner_name: "研究负责人",
  project_identifier: "PD-12",
  org_unit_name: "先进材料课题组",
  status: "ACTIVE",
  visibility: "MEMBERS",
  open_task_count: 2,
  created_at: "2026-09-01T01:00:00Z",
  updated_at: "2026-10-28T09:30:00Z",
};

const fixtureMembers: TResearchChainMember[] = [
  { user_id: "owner", display_name: "研究负责人", role: "OWNER", is_owner: true },
  { user_id: "advisor", display_name: "直接导师", role: "ADMIN", is_owner: false },
  { user_id: "pi", display_name: "主 PI", role: "ADMIN", is_owner: false },
  { user_id: "student", display_name: "王同学", role: "MEMBER", is_owner: false },
];

const fixtureEvents: TResearchChainEvent[] = [
  {
    schema_version: "research-event.v1",
    event_id: "event-3",
    node: "node-experiment",
    actor: "owner",
    actor_type: "USER",
    source_system: "PLANE",
    request_id: "request-3",
    trace_id: "",
    event_type: "MATERIAL_LINKED",
    occurred_at: "2026-10-28T08:00:00Z",
    refs: [],
    summary: "关联材料「正式实验方案 v2」",
    content_hash: "hash-3",
  },
  {
    schema_version: "research-event.v1",
    event_id: "event-2",
    node: "node-experiment",
    actor: "owner",
    actor_type: "USER",
    source_system: "PLANE",
    request_id: "request-2",
    trace_id: "",
    event_type: "TASK_COMPLETED",
    occurred_at: "2026-10-27T06:00:00Z",
    refs: [],
    summary: "完成任务「确认实验分组」",
    content_hash: "hash-2",
  },
  {
    schema_version: "research-event.v1",
    event_id: "event-1",
    node: "node-experiment",
    actor: "owner",
    actor_type: "USER",
    source_system: "PLANE",
    request_id: "request-1",
    trace_id: "",
    event_type: "NODE_CREATED",
    occurred_at: "2026-10-20T01:00:00Z",
    refs: [],
    summary: "创建节点「正式实验」",
    content_hash: "hash-1",
  },
];

const fixtureTasks: TResearchChainNodeTask[] = [
  {
    schema_version: "research-node-task.v1",
    id: "task-1",
    workspace: "fixture-workspace",
    chain: "fixture-chain",
    node: "node-experiment",
    title: "补充 SOP 标准操作流程",
    instruction: "",
    instruction_attachments: [],
    status: "ASSIGNED",
    assignee: "student",
    assignee_detail: { id: "student", display_name: "王同学" },
    assignee_is_valid: true,
    assigned_by: null,
    completed_by: null,
    due_at: "2026-10-30T00:00:00Z",
    completed_at: null,
    resource_type: "NONE",
    resource_id: null,
    request_id: "fixture-request",
    created_at: "2026-10-26T01:00:00Z",
    updated_at: "2026-10-26T01:00:00Z",
  },
  {
    schema_version: "research-node-task.v1",
    id: "task-2",
    workspace: "fixture-workspace",
    chain: "fixture-chain",
    node: "node-experiment",
    title: "整理第一轮实验数据",
    instruction: "",
    instruction_attachments: [],
    status: "DRAFT",
    assignee: null,
    assignee_detail: null,
    assignee_is_valid: true,
    assigned_by: null,
    completed_by: null,
    due_at: null,
    completed_at: null,
    resource_type: "NONE",
    resource_id: null,
    request_id: "fixture-request-2",
    created_at: "2026-10-27T01:00:00Z",
    updated_at: "2026-10-27T01:00:00Z",
  },
];

const scenarios: Record<
  string,
  {
    label: string;
    nodes: TResearchChainNode[];
    stages: TResearchChainStageApproval[];
    progress: TResearchChainStageApprovalSummary["progress"];
  }
> = {
  working: {
    label: "进行中 / 缺材料 / 有待办",
    nodes: [
      fixtureNode("node-literature", "LITERATURE_REVIEW", "文献调研", "COMPLETED"),
      fixtureNode("node-experiment", "EXPERIMENT", "正式实验", "ACTIVE"),
    ],
    stages: [
      approvedLiterature,
      baseStage({
        materials: [
          completeMaterial("material-plan", "FORMAL_EXPERIMENT_PLAN", "正式实验方案"),
          missingMaterial("material-sop", "SOP", "SOP"),
        ],
      }),
    ],
    progress: {
      total: 13,
      approved: 5,
      awaiting_advisor: 1,
      awaiting_pi: 0,
      needs_revision: 1,
      in_progress: 1,
      not_started: 5,
    },
  },
  review: {
    label: "待导师审批 / 材料齐备",
    nodes: [
      fixtureNode("node-literature", "LITERATURE_REVIEW", "文献调研", "COMPLETED"),
      fixtureNode("node-experiment", "EXPERIMENT", "正式实验", "WAITING_HUMAN"),
    ],
    stages: [
      approvedLiterature,
      baseStage({
        status: "AWAITING_ADVISOR",
        current_review_step: "ADVISOR",
        submitted_node: "node-experiment",
        materials: [
          completeMaterial("material-plan", "FORMAL_EXPERIMENT_PLAN", "正式实验方案"),
          completeMaterial("material-sop", "SOP", "SOP"),
        ],
        capabilities: {
          schema_version: "research-capabilities.v1",
          actions: { edit_materials: decision(false), submit: decision(false), review: decision(true) },
        },
      }),
    ],
    progress: {
      total: 13,
      approved: 5,
      awaiting_advisor: 1,
      awaiting_pi: 0,
      needs_revision: 0,
      in_progress: 0,
      not_started: 7,
    },
  },
  empty: {
    label: "空课题 / 引导创建节点",
    nodes: [],
    stages: [approvedLiterature],
    progress: {
      total: 13,
      approved: 0,
      awaiting_advisor: 0,
      awaiting_pi: 0,
      needs_revision: 0,
      in_progress: 0,
      not_started: 13,
    },
  },
};

const scenarioName = new URLSearchParams(window.location.search).get("scenario") ?? "working";
const scenario = scenarios[scenarioName] ?? scenarios.working;
const currentNode = scenario.nodes.find((node) => node.status !== "COMPLETED") ?? scenario.nodes[0] ?? null;
const workflow = buildResearchWorkflow(scenario.nodes, currentNode?.id ?? null, scenario.stages);
const stageApprovalSummary: TResearchChainStageApprovalSummary = {
  chain: "fixture-chain",
  chain_status: "ACTIVE",
  stages: scenario.stages,
  progress: scenario.progress,
};

ResearchChainService.prototype.getChainNodeDetail = async () => ({
  node: currentNode,
  events: fixtureEvents,
  snapshots: [],
});
ResearchChainService.prototype.submitChainStage = async () => undefined;
ResearchChainService.prototype.reviewChainStage = async () => scenario.stages[0];
ResearchChainTaskService.prototype.getNodeTasks = async () => fixtureTasks;

await setLanguage("zh-CN");
document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(
  <TranslationProvider>
    <main className="min-h-screen bg-canvas">
      <section className="mx-auto max-w-5xl overflow-hidden rounded-lg border border-subtle bg-surface-1">
        <p className="border-b border-subtle px-4 py-2 text-11 text-tertiary">{scenario.label}</p>
        <ResearchChainOverviewCommand
          workspaceSlug="fixture-workspace"
          chainId="fixture-chain"
          chain={fixtureChain}
          nodes={scenario.nodes}
          members={fixtureMembers}
          currentNode={currentNode}
          stages={workflow.stages}
          stageApprovalSummary={stageApprovalSummary}
          onOpenStage={() => undefined}
          onOpenMembers={() => undefined}
          onCreateNode={() => undefined}
          onOpenAgent={() => undefined}
          onRefresh={() => undefined}
        />
      </section>
    </main>
  </TranslationProvider>
);
