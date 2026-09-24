"use client";

import { useMemo } from "react";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TResearchChainNode } from "@plane/types";

type Props = {
  nodes: TResearchChainNode[];
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
};

type TGraphLayout = {
  positions: Map<string, { x: number; y: number }>;
  edges: Array<{ from: string; to: string; loop: boolean }>;
  width: number;
  height: number;
};

const NODE_WIDTH = 184;
const NODE_HEIGHT = 76;
const COLUMN_GAP = 64;
const ROW_GAP = 28;

/** Lay out parent/child nodes without following cyclic parent references. */
function layout(nodes: TResearchChainNode[]): TGraphLayout {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of nodes) {
    const parent = node.parent_node && byId.has(node.parent_node) ? node.parent_node : null;
    if (parent) {
      children.set(parent, [...(children.get(parent) ?? []), node.id]);
    } else {
      roots.push(node.id);
    }
  }

  const positions = new Map<string, { x: number; y: number }>();
  const visited = new Set<string>();
  let row = 0;
  let maxDepth = 0;
  const walk = (nodeId: string, depth: number) => {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    maxDepth = Math.max(maxDepth, depth);
    positions.set(nodeId, { x: depth * (NODE_WIDTH + COLUMN_GAP), y: row * (NODE_HEIGHT + ROW_GAP) });
    row += 1;
    for (const child of children.get(nodeId) ?? []) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  for (const node of nodes) walk(node.id, 0);

  return {
    positions,
    edges: nodes
      .filter((node) => node.parent_node && positions.has(node.parent_node))
      .map((node) => ({
        from: node.parent_node as string,
        to: node.id,
        loop: node.loop_iteration > 0,
      })),
    width: (maxDepth + 1) * NODE_WIDTH + maxDepth * COLUMN_GAP + 24,
    height: row * NODE_HEIGHT + Math.max(0, row - 1) * ROW_GAP + 24,
  };
}

/** Main-chain visualization with status, current selection, loops and failure hints. */
export function ResearchChainGraph({ nodes, selectedNodeId, onSelect }: Props) {
  const { t } = useTranslation();
  const graph = useMemo(() => layout(nodes), [nodes]);

  if (!nodes.length) {
    return <p className="p-4 text-12 text-secondary">{t("research.chains.nodes_empty")}</p>;
  }

  return (
    <div className="overflow-x-auto p-4" role="group" aria-label={t("research.chains.graph_title")}>
      <div className="relative" style={{ width: graph.width, height: graph.height }}>
        <svg className="absolute inset-0" width={graph.width} height={graph.height} aria-hidden="true">
          {graph.edges.map((edge) => {
            const from = graph.positions.get(edge.from);
            const to = graph.positions.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + NODE_WIDTH;
            const y1 = from.y + NODE_HEIGHT / 2;
            const x2 = to.x;
            const y2 = to.y + NODE_HEIGHT / 2;
            return (
              <path
                key={`${edge.from}-${edge.to}`}
                d={`M ${x1} ${y1} H ${x2 - 16} M ${x2 - 22} ${y2 - 5} L ${x2 - 12} ${y2} L ${x2 - 22} ${y2 + 5}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.2}
                strokeDasharray={edge.loop ? "4 4" : undefined}
                className="text-border"
              />
            );
          })}
        </svg>
        {nodes.map((node) => {
          const position = graph.positions.get(node.id);
          if (!position) return null;
          const selected = node.id === selectedNodeId;
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelect(node.id)}
              aria-pressed={selected}
              aria-current={selected ? "step" : undefined}
              className={`absolute flex flex-col justify-center rounded-lg border bg-surface-1 px-3 text-left transition-colors hover:bg-surface-2 ${
                selected ? "border-accent-strong" : "border-subtle"
              }`}
              style={{ left: position.x, top: position.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-12 font-medium text-primary">{node.title}</span>
                {node.loop_iteration > 0 && (
                  <span className="rounded border border-subtle bg-surface-2 px-1.5 text-10 text-secondary">
                    R{node.loop_iteration}
                  </span>
                )}
              </span>
              <span className="mt-1 truncate text-11 text-secondary">
                {t(`research.chains.node_status.${node.status.toLowerCase()}`)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
