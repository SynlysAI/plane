"use client";

import type { ReactNode } from "react";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TResearchChainEvent, TResearchChainNode, TResearchChainSnapshot } from "@plane/types";
// components
import { formatResearchDateTime } from "@/components/research/common/research-format";
import { ResearchChainNodeDetail } from "@/components/research/chains/research-chain-node-detail";
import type { TResearchWorkflowStage } from "@/components/research/chains/research-chain-workflow";

export type TResearchChainStageNodeDetail = {
  node: TResearchChainNode;
  events: TResearchChainEvent[];
  snapshots: TResearchChainSnapshot[];
};

type Props = {
  stage: TResearchWorkflowStage;
  nodes: TResearchChainNode[];
  details: TResearchChainStageNodeDetail[];
  selectedNodeId: string | null;
  loading: boolean;
  error: boolean;
  onSelectNode: (nodeId: string) => void;
  actionSlot?: ReactNode;
};

const SNAPSHOT_TYPE_LABELS: Partial<Record<TResearchChainSnapshot["snapshot_type"], string>> = {
  LITERATURE_REVIEW: "research.chains.snapshot_type_literature_review",
  EXPERIMENT_EXECUTION: "research.chains.snapshot_type_experiment_execution",
  EXPERIMENT_DATA: "research.chains.snapshot_type_experiment_data",
  ANALYSIS_RESULT: "research.chains.snapshot_type_analysis_result",
  PAPER_RESEARCH: "research.chains.snapshot_type_paper_research",
  PROCESS: "research.chains.snapshot_type_process",
};

/** Convert an event reference to a compact human-readable label. */
function referenceLabel(reference: Record<string, unknown>) {
  const title = reference.title ?? reference.name ?? reference.display_name;
  if (typeof title === "string" && title.trim()) return title;
  const identity = reference.id ?? reference.knowledge_id ?? reference.external_id;
  return typeof identity === "string" ? identity : "";
}

/** Render one workflow stage with its nodes, immutable snapshots and trace log. */
export function ResearchChainWorkflowStageDetail({
  stage,
  nodes,
  details,
  selectedNodeId,
  loading,
  error,
  onSelectNode,
  actionSlot,
}: Props) {
  const { t, currentLocale } = useTranslation();
  const detailById = new Map(details.map((detail) => [detail.node.id, detail]));
  const selectedDetail = selectedNodeId ? detailById.get(selectedNodeId) : undefined;
  const snapshots = details
    .flatMap((detail) =>
      detail.snapshots.map((snapshot) => ({
        snapshot,
        nodeId: detail.node.id,
        nodeTitle: detail.node.title,
      }))
    )
    // The array is created by flatMap, so sorting it cannot mutate source data.
    // eslint-disable-next-line unicorn/no-array-sort -- TypeScript target does not include Array#toSorted.
    .sort((left, right) => {
      const nodeResult = left.nodeTitle.localeCompare(right.nodeTitle, currentLocale);
      return nodeResult !== 0 ? nodeResult : left.snapshot.version - right.snapshot.version;
    });
  const events = details
    .flatMap((detail) => detail.events.map((event) => ({ event, nodeId: detail.node.id })))
    // The array is created by flatMap, so sorting it cannot mutate source data.
    // eslint-disable-next-line unicorn/no-array-sort -- TypeScript target does not include Array#toSorted.
    .sort(
      (left, right) =>
        left.event.occurred_at.localeCompare(right.event.occurred_at) ||
        left.event.event_id.localeCompare(right.event.event_id)
    );
  const statusLabel =
    stage.status === "NOT_STARTED"
      ? t("research.chains.workflow.not_started")
      : t(`research.chains.node_status.${stage.status.toLowerCase()}`);

  return (
    <section className="p-5" aria-label={t("research.chains.workflow.stage_detail_title")}>
      <div className="overflow-hidden rounded-xl border border-subtle bg-surface-1">
        <header className="border-b border-subtle px-5 py-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="text-15 font-semibold text-primary">{t(stage.labelKey)}</h3>
            <span className="text-12 text-secondary">{statusLabel}</span>
            {stage.shared && <span className="text-11 text-tertiary">{t("research.chains.workflow.shared")}</span>}
            {stage.associatedNodeIds.length > 0 && (
              <span className="text-11 text-tertiary">{t("research.chains.workflow.preparation")}</span>
            )}
          </div>
          <p className="mt-1 text-12 text-tertiary">
            {t("research.chains.workflow.stage_node_count", { count: nodes.length })}
          </p>
        </header>

        <div className="grid grid-cols-1 border-b border-subtle xl:grid-cols-[280px_minmax(0,1fr)]">
          <div
            className="border-subtle p-4 xl:border-r"
            role="region"
            aria-label={t("research.chains.workflow.stage_nodes")}
          >
            <h4 className="text-12 font-semibold text-primary">{t("research.chains.workflow.stage_nodes")}</h4>
            <div className="mt-3 space-y-1" role="list">
              {nodes.map((node) => {
                const selected = node.id === selectedNodeId;
                const associated = stage.associatedNodeIds.includes(node.id);
                const unmapped = !stage.nodeIds.includes(node.id) && !stage.associatedNodeIds.includes(node.id);
                return (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => onSelectNode(node.id)}
                    aria-pressed={selected || undefined}
                    className={`flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors hover:bg-surface-2 ${
                      selected ? "ring-border-strong border-strong ring-1" : "border-transparent"
                    }`}
                  >
                    <span className="flex min-w-0 items-center justify-between gap-2">
                      <span className="truncate text-12 font-medium text-primary">{node.title}</span>
                      {node.loop_iteration > 0 && (
                        <span className="shrink-0 text-10 text-secondary">R{node.loop_iteration}</span>
                      )}
                    </span>
                    <span className="truncate text-11 text-secondary">
                      {t(`research.chains.node_status.${node.status.toLowerCase()}`)}
                      {associated ? ` · ${t("research.chains.workflow.preparation")}` : ""}
                      {unmapped ? ` · ${t("research.chains.workflow.unmapped_node")}` : ""}
                    </span>
                  </button>
                );
              })}
              {!nodes.length && <p className="text-12 text-tertiary">{t("research.chains.workflow.stage_empty")}</p>}
            </div>
          </div>

          <div className="grid min-w-0 grid-cols-1 2xl:grid-cols-2">
            <section className="border-subtle p-4 2xl:border-r" aria-label={t("research.chains.snapshots_title")}>
              <h4 className="text-12 font-semibold text-primary">{t("research.chains.snapshots_title")}</h4>
              {loading ? (
                <p className="mt-3 text-12 text-tertiary">{t("research.common.loading")}</p>
              ) : (
                <ul className="mt-3 divide-y divide-subtle" role="list">
                  {snapshots.map(({ snapshot, nodeId, nodeTitle }) => (
                    <li
                      key={`${nodeId}-${snapshot.snapshot_id}-${snapshot.version}`}
                      className="py-2 first:pt-0 last:pb-0"
                    >
                      <p className="text-12 font-medium text-primary">
                        {t(SNAPSHOT_TYPE_LABELS[snapshot.snapshot_type] ?? "research.chains.workflow.stage_snapshot")}·{" "}
                        {t("research.chains.workflow.snapshot_version", { version: snapshot.version })}
                      </p>
                      <p className="mt-1 line-clamp-2 text-12 text-secondary">{snapshot.summary}</p>
                      <p className="mt-1 text-11 text-tertiary">
                        {nodeTitle} · {formatResearchDateTime(snapshot.created_at, currentLocale)}
                        {snapshot.source_versions.length
                          ? ` · ${snapshot.source_versions.map(referenceLabel).filter(Boolean).join("、")}`
                          : ""}
                      </p>
                    </li>
                  ))}
                  {!snapshots.length && (
                    <li className="py-2 text-12 text-tertiary">{t("research.chains.workflow.stage_snapshot_empty")}</li>
                  )}
                </ul>
              )}
            </section>

            <section className="border-subtle p-4" aria-label={t("research.chains.workflow.trace_title")}>
              <h4 className="text-12 font-semibold text-primary">{t("research.chains.workflow.trace_title")}</h4>
              {loading ? (
                <p className="mt-3 text-12 text-tertiary">{t("research.common.loading")}</p>
              ) : (
                <ol className="mt-3 space-y-0 border-l border-subtle pl-4" role="list">
                  {events.map(({ event, nodeId }) => (
                    <li
                      key={`${nodeId}-${event.event_id}-${event.occurred_at}`}
                      className="relative py-2 pl-4 first:pt-0 last:pb-0"
                    >
                      <span
                        className="bg-border-strong absolute top-[15px] -left-[21px] size-2 rounded-full"
                        aria-hidden="true"
                      />
                      <p className="text-12 font-medium text-primary">{event.summary || event.event_type}</p>
                      <p className="mt-1 text-11 text-tertiary">
                        {formatResearchDateTime(event.occurred_at, currentLocale)} · {event.actor_type} ·{" "}
                        {event.source_system}
                      </p>
                      <p className="mt-0.5 truncate text-11 text-tertiary">
                        {event.trace_id
                          ? t("research.chains.workflow.trace_id", { id: event.trace_id })
                          : t("research.chains.workflow.trace_id_empty")}
                      </p>
                    </li>
                  ))}
                  {!events.length && (
                    <li className="py-2 text-12 text-tertiary">{t("research.chains.workflow.trace_empty")}</li>
                  )}
                </ol>
              )}
            </section>
          </div>
        </div>

        {error && (
          <p className="border-b border-subtle px-5 py-3 text-12 text-danger-primary" role="alert">
            {t("research.chains.workflow.detail_load_failed")}
          </p>
        )}

        {actionSlot && <div className="border-b border-subtle">{actionSlot}</div>}

        {selectedDetail && <ResearchChainNodeDetail {...selectedDetail} />}
      </div>
    </section>
  );
}
