/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Check, ChevronRight } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TResearchChainNode } from "@plane/types";
// components
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";

type Props = {
  nodes: TResearchChainNode[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
};

/** Same urgency ordering as the chain detail current-node selector. */
const STATUS_PRIORITY: Record<TResearchChainNode["status"], number> = {
  WAITING_HUMAN: 0,
  NEEDS_REVISION: 1,
  FAILED: 2,
  ACTIVE: 3,
  DRAFT: 4,
  COMPLETED: 5,
  ARCHIVED: 6,
};

/** Order nodes by the structure walk (parents before children) without cyclic references. */
function orderedNodes(nodes: TResearchChainNode[]) {
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

/** Derive the visual step kind from node status. */
function stepKind(node: TResearchChainNode, isCurrent: boolean) {
  if (isCurrent) return "current" as const;
  if (node.status === "COMPLETED") return "completed" as const;
  if (node.status === "WAITING_HUMAN" || node.status === "NEEDS_REVISION" || node.status === "FAILED")
    return "attention" as const;
  return "upcoming" as const;
}

const STEP_DOT_CLASSES = {
  completed: "border-success-subtle bg-success-subtle-1 text-success-primary",
  current: "border-accent-strong bg-accent-primary text-on-color",
  attention: "border-warning-subtle bg-warning-subtle text-warning-primary",
  upcoming: "border-subtle bg-surface-2 text-tertiary",
} as const;

const STEP_TITLE_CLASSES = {
  completed: "text-secondary",
  current: "font-medium text-primary",
  attention: "text-primary",
  upcoming: "text-tertiary",
} as const;

/**
 * Horizontal workflow rail: renders every chain node as a process step so the
 * whole research flow, the current position and what remains are visible at a glance.
 */
export function ResearchChainWorkflowRail({ nodes, selectedNodeId, onSelect }: Props) {
  const { t } = useTranslation();
  if (!nodes.length) return null;

  const ordered = orderedNodes(nodes);
  /* eslint-disable unicorn/no-array-sort */
  const currentNode = [...ordered]
    .sort(
      (left, right) =>
        STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status] ||
        new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime()
    )
    .at(0);
  /* eslint-enable unicorn/no-array-sort */

  return (
    <div
      className="flex items-stretch gap-1 overflow-x-auto border-b border-subtle px-5 py-3"
      role="list"
      aria-label={t("research.chains.workflow_title")}
    >
      {ordered.map((node, index) => {
        const isCurrent = node.id === currentNode?.id;
        const kind = stepKind(node, isCurrent);
        const selected = node.id === selectedNodeId;
        return (
          <div key={node.id} className="flex items-stretch" role="listitem">
            {index > 0 && (
              <span className="flex items-center text-tertiary" aria-hidden="true">
                <ChevronRight className="size-3.5" />
              </span>
            )}
            <button
              type="button"
              onClick={() => onSelect(node.id)}
              aria-current={isCurrent ? "step" : undefined}
              aria-pressed={selected}
              title={node.title}
              className={`flex max-w-56 min-w-36 flex-col gap-1 rounded-md border px-2.5 py-2 text-left transition-colors ${
                selected ? "border-strong bg-surface-2" : "border-transparent hover:bg-surface-2"
              }`}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className={`grid size-4 shrink-0 place-items-center rounded-full border ${STEP_DOT_CLASSES[kind]}`}
                  aria-hidden="true"
                >
                  {kind === "completed" && <Check className="size-2.5" strokeWidth={3} />}
                </span>
                <span className={`truncate text-12 ${STEP_TITLE_CLASSES[kind]}`}>{node.title}</span>
                {node.loop_iteration > 0 && (
                  <span className="shrink-0 rounded bg-surface-2 px-1 text-10 text-secondary">
                    R{node.loop_iteration}
                  </span>
                )}
              </span>
              <ResearchStatusBadge status={node.status} size="sm">
                {t(`research.chains.node_status.${node.status.toLowerCase()}`)}
              </ResearchStatusBadge>
            </button>
          </div>
        );
      })}
    </div>
  );
}
