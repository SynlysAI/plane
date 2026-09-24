import type { TResearchChainNode } from "@plane/types";
import { pickCurrentNode } from "./research-selection";

/** Fixed thirteen-stage research process definition used by the workflow map. */
export const RESEARCH_WORKFLOW_STAGE_DEFINITIONS = [
  { id: "literature_review", labelKey: "research.chains.workflow.stages.literature_review" },
  { id: "topic_selection", labelKey: "research.chains.workflow.stages.topic_selection" },
  { id: "topic_evaluation", labelKey: "research.chains.workflow.stages.topic_evaluation" },
  { id: "pre_experiment", labelKey: "research.chains.workflow.stages.pre_experiment" },
  { id: "analysis_pre_experiment", labelKey: "research.chains.workflow.stages.analysis_pre_experiment" },
  { id: "opening", labelKey: "research.chains.workflow.stages.opening" },
  { id: "experiment", labelKey: "research.chains.workflow.stages.experiment" },
  { id: "analysis_experiment", labelKey: "research.chains.workflow.stages.analysis_experiment" },
  { id: "iteration", labelKey: "research.chains.workflow.stages.iteration" },
  { id: "summary", labelKey: "research.chains.workflow.stages.summary" },
  { id: "paper_writing", labelKey: "research.chains.workflow.stages.paper_writing" },
  { id: "completion", labelKey: "research.chains.workflow.stages.completion" },
  { id: "transfer", labelKey: "research.chains.workflow.stages.transfer" },
] as const;

export type TResearchWorkflowStageId = (typeof RESEARCH_WORKFLOW_STAGE_DEFINITIONS)[number]["id"];

export type TResearchWorkflowStageStatus = TResearchChainNode["status"] | "NOT_STARTED";

export type TResearchWorkflowStage = {
  id: TResearchWorkflowStageId;
  labelKey: string;
  status: TResearchWorkflowStageStatus;
  /** True only for the visual stage carrying the real current business node. */
  isCurrent: boolean;
  /** Business nodes that determine this stage status. */
  nodeIds: string[];
  /** Preparation or shared nodes shown without overriding the stage status. */
  associatedNodeIds: string[];
  /** Node opened when the stage is clicked; may be an associated preparation node. */
  preferredNodeId: string | null;
  /** True when one business node is deliberately shared by two visual stages. */
  shared: boolean;
};

export type TResearchWorkflow = {
  stages: TResearchWorkflowStage[];
  /** Nodes that cannot be safely mapped to a fixed stage. */
  unmappedNodes: TResearchChainNode[];
};

const PRIMARY_TYPES: Partial<Record<TResearchWorkflowStageId, string[]>> = {
  literature_review: ["LITERATURE_REVIEW"],
  pre_experiment: ["PRE_EXPERIMENT"],
  opening: ["OPENING"],
  experiment: ["EXPERIMENT"],
  iteration: ["ITERATION"],
  summary: ["SUMMARY"],
  paper_writing: ["PAPER_WRITING"],
  completion: ["COMPLETION"],
  transfer: ["TRANSFER"],
};

/** Walk parent references in creation order while tolerating missing or cyclic parents. */
function orderedNodes(nodes: TResearchChainNode[]): TResearchChainNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of nodes) {
    const parent = node.parent_node && byId.has(node.parent_node) ? node.parent_node : null;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), node.id]);
    else roots.push(node.id);
  }
  const visited = new Set<string>();
  const result: TResearchChainNode[] = [];
  const walk = (nodeId: string) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = byId.get(nodeId);
    if (node) result.push(node);
    for (const child of children.get(nodeId) ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  for (const node of nodes) walk(node.id);
  return result;
}

/** Collect all ancestor types for a node without following a cycle twice. */
function ancestorTypes(node: TResearchChainNode, byId: Map<string, TResearchChainNode>): Set<string> {
  const types = new Set<string>();
  const visited = new Set<string>();
  let parent = node.parent_node;
  while (parent && !visited.has(parent)) {
    visited.add(parent);
    const parentNode = byId.get(parent);
    if (!parentNode) break;
    types.add(parentNode.node_type);
    parent = parentNode.parent_node;
  }
  return types;
}

/** Pick the node a stage should open without changing the real current node. */
function preferredNode(nodes: TResearchChainNode[], currentNodeId: string | null): TResearchChainNode | null {
  if (currentNodeId) {
    const current = nodes.find((node) => node.id === currentNodeId);
    if (current) return current;
  }
  return pickCurrentNode(nodes);
}

/** Map a node type to its fixed workflow stage when the type has a primary mapping. */
function primaryStageForType(nodeType: string): TResearchWorkflowStageId | undefined {
  return RESEARCH_WORKFLOW_STAGE_DEFINITIONS.find((definition) => PRIMARY_TYPES[definition.id]?.includes(nodeType))?.id;
}

/** Find the nearest directly mappable neighbor stage in one direction. */
function nearestStageInDirection(
  ordered: TResearchChainNode[],
  from: number,
  step: -1 | 1
): TResearchWorkflowStageId | undefined {
  for (let position = from + step; position >= 0 && position < ordered.length; position += step) {
    const stage = primaryStageForType(ordered[position].node_type);
    if (stage) return stage;
  }
  return undefined;
}

/** Derive one stage status from its primary nodes and the real current node. */
function stageStatus(nodes: TResearchChainNode[], currentNodeId: string | null): TResearchWorkflowStageStatus {
  const current = currentNodeId ? nodes.find((node) => node.id === currentNodeId) : undefined;
  if (current) return current.status;
  const representative = preferredNode(nodes, null);
  return representative?.status ?? "NOT_STARTED";
}

/**
 * Build the fixed research workflow from existing chain nodes.
 *
 * Args:
 *   nodes: Business nodes returned by the chain API.
 *   currentNodeId: The real current node ID selected by the chain page.
 *
 * Returns:
 *   Thirteen fixed stages plus nodes that cannot be safely mapped.
 */
export function buildResearchWorkflow(
  nodes: TResearchChainNode[],
  currentNodeId: string | null = null
): TResearchWorkflow {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ordered = orderedNodes(nodes);
  const orderedIndex = new Map(ordered.map((node, index) => [node.id, index]));
  const primary = new Map<TResearchWorkflowStageId, string[]>();
  const associated = new Map<TResearchWorkflowStageId, string[]>();
  const shared = new Set<TResearchWorkflowStageId>();
  const unmappedNodes: TResearchChainNode[] = [];

  const addPrimary = (stage: TResearchWorkflowStageId, node: TResearchChainNode) => {
    primary.set(stage, [...(primary.get(stage) ?? []), node.id]);
  };
  const addAssociated = (stage: TResearchWorkflowStageId, node: TResearchChainNode) => {
    associated.set(stage, [...(associated.get(stage) ?? []), node.id]);
  };

  for (const node of ordered) {
    if (node.node_type === "TOPIC_EVALUATION") {
      addPrimary("topic_evaluation", node);
      shared.add("topic_selection");
      shared.add("topic_evaluation");
      continue;
    }
    if (node.node_type === "ANALYSIS") {
      const ancestors = ancestorTypes(node, byId);
      if (ancestors.has("EXPERIMENT") || ancestors.has("ITERATION")) addPrimary("analysis_experiment", node);
      else if (ancestors.has("PRE_EXPERIMENT")) addPrimary("analysis_pre_experiment", node);
      else unmappedNodes.push(node);
      continue;
    }
    if (node.node_type === "PLAN") {
      addAssociated("opening", node);
      continue;
    }

    const stage = primaryStageForType(node.node_type);
    if (stage) {
      addPrimary(stage, node);
      continue;
    }

    // Generic research nodes stay visible as supporting evidence next to their
    // nearest mappable neighbor. Predecessors win; successors cover chain heads.
    const index = orderedIndex.get(node.id) ?? 0;
    const neighborStage = nearestStageInDirection(ordered, index, -1) ?? nearestStageInDirection(ordered, index, 1);
    if (node.node_type === "RESEARCH" && neighborStage) addAssociated(neighborStage, node);
    else unmappedNodes.push(node);
  }

  const stages = RESEARCH_WORKFLOW_STAGE_DEFINITIONS.map((definition) => {
    const primaryNodes = (primary.get(definition.id) ?? [])
      .map((nodeId) => byId.get(nodeId))
      .filter((node): node is TResearchChainNode => Boolean(node));
    const associatedNodes = (associated.get(definition.id) ?? [])
      .map((nodeId) => byId.get(nodeId))
      .filter((node): node is TResearchChainNode => Boolean(node));
    const sharedNodes =
      definition.id === "topic_selection" || definition.id === "topic_evaluation"
        ? (primary.get("topic_evaluation") ?? [])
            .map((nodeId) => byId.get(nodeId))
            .filter((node): node is TResearchChainNode => Boolean(node))
        : [];
    const statusNodes = [...primaryNodes, ...sharedNodes];

    let status = stageStatus(statusNodes, currentNodeId);
    let isCurrent = Boolean(currentNodeId && statusNodes.some((item) => item.id === currentNodeId));
    if ((definition.id === "topic_selection" || definition.id === "topic_evaluation") && sharedNodes.length) {
      const topicNode = sharedNodes[0];
      if (definition.id === "topic_selection" && topicNode.status !== "DRAFT" && topicNode.status !== "ACTIVE") {
        status = "COMPLETED";
        isCurrent = false;
      }
      if (definition.id === "topic_evaluation" && (topicNode.status === "DRAFT" || topicNode.status === "ACTIVE")) {
        status = "NOT_STARTED";
        isCurrent = false;
      }
    }
    const clickableNodes = [...primaryNodes, ...sharedNodes, ...associatedNodes];
    const preferred = preferredNode(clickableNodes, currentNodeId);

    return {
      id: definition.id,
      labelKey: definition.labelKey,
      status,
      isCurrent,
      nodeIds: [...new Set([...primaryNodes, ...sharedNodes].map((node) => node.id))],
      associatedNodeIds: associatedNodes.map((node) => node.id),
      preferredNodeId: preferred?.id ?? null,
      shared: shared.has(definition.id),
    };
  });

  return { stages, unmappedNodes };
}
