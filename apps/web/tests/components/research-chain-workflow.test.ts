import {
  buildResearchWorkflow,
  RESEARCH_WORKFLOW_STAGE_DEFINITIONS,
} from "@/components/research/chains/research-chain-workflow";
import type { TResearchChainNode, TResearchChainStageApproval } from "@plane/types";
import { expect, it } from "vitest";

type TNodeSeed = Partial<TResearchChainNode> & { id: string; node_type: string; title: string };

/** Create a typed chain-node fixture with the invariant defaults from the API contract. */
function node(seed: TNodeSeed): TResearchChainNode {
  return {
    schema_version: "research-node.v1",
    chain: "chain-1",
    parent_node: null,
    loop_iteration: 0,
    status: "DRAFT",
    assignee: "user-1",
    created_at: "2026-09-23T01:00:00Z",
    updated_at: "2026-09-23T01:00:00Z",
    ...seed,
  };
}

function stageApproval(seed: { stage_code: string; status?: TResearchChainStageApproval["status"] }) {
  return {
    schema_version: "research-chain-stage.v1",
    id: `stage-${seed.stage_code}`,
    chain: "chain-1",
    sort_order: 1,
    status: seed.status ?? "NOT_STARTED",
    pi_policy: "ADVISOR_ONLY",
    requires_pi: false,
    escalation_reason: "",
    attempt_count: 0,
    submitted_node: null,
    submitted_at: null,
    approved_at: null,
    materials: [],
    review_actions: [],
    latest_precheck: null,
    advisor: { user: null, error: null },
    principal_investigator: { user: null, error: null },
    current_review_step: null,
    created_at: "2026-09-23T01:00:00Z",
    updated_at: "2026-09-23T01:00:00Z",
    ...seed,
  } satisfies TResearchChainStageApproval;
}

it("keeps all thirteen research stages visible for an empty chain", () => {
  const workflow = buildResearchWorkflow([]);

  expect(workflow.stages.map((stage) => stage.id)).toEqual(
    RESEARCH_WORKFLOW_STAGE_DEFINITIONS.map((stage) => stage.id)
  );
  expect(workflow.stages.every((stage) => stage.status === "NOT_STARTED")).toBe(true);
  expect(workflow.stages.every((stage) => stage.preferredNodeId === null)).toBe(true);
});

it("maps selection and evaluation to independent business nodes", () => {
  const selectionNode = node({ id: "selection", node_type: "TOPIC_SELECTION", title: "选题", status: "DRAFT" });
  const evaluationNode = node({
    id: "topic",
    node_type: "TOPIC_EVALUATION",
    title: "选题评估",
    status: "WAITING_HUMAN",
  });
  const workflow = buildResearchWorkflow([selectionNode, evaluationNode], evaluationNode.id);
  const selection = workflow.stages.find((stage) => stage.id === "topic_selection");
  const evaluation = workflow.stages.find((stage) => stage.id === "topic_evaluation");

  expect(selection?.nodeIds).toEqual(["selection"]);
  expect(evaluation?.nodeIds).toEqual(["topic"]);
});

it("uses backend stage approval status instead of the mapped node status", () => {
  const literature = node({ id: "literature", node_type: "LITERATURE_REVIEW", title: "文献调研", status: "COMPLETED" });
  const workflow = buildResearchWorkflow([literature], literature.id, [
    stageApproval({ stage_code: "LITERATURE_REVIEW", status: "AWAITING_ADVISOR" }),
  ]);

  expect(workflow.stages.find((stage) => stage.id === "literature_review")?.status).toBe("AWAITING_ADVISOR");
});

it("separates the two analysis stages by chain structure", () => {
  const preAnalysis = node({
    id: "analysis-1",
    node_type: "ANALYSIS",
    title: "预实验分析",
    parent_node: "pre",
    status: "COMPLETED",
  });
  const experimentAnalysis = node({
    id: "analysis-2",
    node_type: "ANALYSIS",
    title: "实验分析",
    parent_node: "iteration",
    status: "ACTIVE",
  });
  const nodes = [
    node({ id: "pre", node_type: "PRE_EXPERIMENT", title: "预实验", status: "COMPLETED" }),
    preAnalysis,
    node({ id: "opening", node_type: "OPENING", title: "开题", status: "COMPLETED" }),
    node({ id: "experiment", node_type: "EXPERIMENT", title: "实验", status: "COMPLETED" }),
    node({ id: "iteration", node_type: "ITERATION", title: "迭代", parent_node: "experiment", status: "COMPLETED" }),
    experimentAnalysis,
  ];
  const workflow = buildResearchWorkflow(nodes, experimentAnalysis.id);

  expect(workflow.stages.find((stage) => stage.id === "analysis_pre_experiment")?.nodeIds).toEqual(["analysis-1"]);
  expect(workflow.stages.find((stage) => stage.id === "analysis_experiment")?.nodeIds).toEqual(["analysis-2"]);
  expect(workflow.stages.find((stage) => stage.id === "analysis_experiment")?.status).toBe("ACTIVE");
});

it("keeps plan as an opening preparation node and exposes unmapped nodes", () => {
  const plan = node({ id: "plan", node_type: "PLAN", title: "研究计划", status: "ACTIVE" });
  const research = node({ id: "research", node_type: "RESEARCH", title: "调研记录" });
  const literature = node({ id: "literature", node_type: "LITERATURE_REVIEW", title: "文献调研", status: "COMPLETED" });
  const workflow = buildResearchWorkflow([plan, research, literature], plan.id);
  const opening = workflow.stages.find((stage) => stage.id === "opening");

  expect(opening?.associatedNodeIds).toEqual(["plan"]);
  expect(opening?.status).toBe("NOT_STARTED");
  expect(opening?.preferredNodeId).toBe("plan");
  expect(workflow.stages.find((stage) => stage.id === "literature_review")?.nodeIds).toEqual(["literature"]);
  expect(workflow.stages.find((stage) => stage.id === "literature_review")?.associatedNodeIds).toEqual(["research"]);
  expect(workflow.unmappedNodes).toEqual([]);
});

it("keeps archived status distinct instead of treating it as a future stage", () => {
  const archived = node({ id: "summary", node_type: "SUMMARY", title: "总结", status: "ARCHIVED" });
  const workflow = buildResearchWorkflow([archived]);
  const summary = workflow.stages.find((stage) => stage.id === "summary");

  expect(summary?.status).toBe("ARCHIVED");
  expect(summary?.isCurrent).toBe(false);
  expect(summary?.preferredNodeId).toBe(archived.id);
});

it("maps a leading research node to its nearest successor stage", () => {
  const research = node({ id: "research", node_type: "RESEARCH", title: "前置调研记录" });
  const literature = node({ id: "literature", node_type: "LITERATURE_REVIEW", title: "文献调研", status: "COMPLETED" });
  const workflow = buildResearchWorkflow([research, literature], literature.id);

  expect(workflow.stages.find((stage) => stage.id === "literature_review")?.associatedNodeIds).toEqual(["research"]);
  expect(workflow.unmappedNodes).toEqual([]);
});
