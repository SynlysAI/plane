"use client";

import { useEffect, useRef, type ReactNode } from "react";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TResearchChainEvent, TResearchChainNode, TResearchChainSnapshot } from "@plane/types";
// components
import { formatResearchDateTime } from "@/components/research/common/research-format";
import {
  ResearchChainNodeDetail,
  summarizeNodeEvidence,
} from "@/components/research/chains/research-chain-node-detail";
import {
  ResearchChainWorkbenchPeek,
  ResearchChainWorkbenchPeekProvider,
  useResearchChainWorkbenchPeek,
} from "@/components/research/chains/research-chain-workbench-peek";
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
  detailSlot?: ReactNode;
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

/**
 * 渲染阶段工作台：浅灰节点列、白底当前节点，以及证据计数 Peek。
 */
export function ResearchChainWorkflowStageDetail(props: Props) {
  return (
    <ResearchChainWorkbenchPeekProvider>
      <ResearchChainWorkflowStageBody {...props} />
    </ResearchChainWorkbenchPeekProvider>
  );
}

/** 阶段工作台正文。Peek 状态来自外层 provider，以便任务面板替换证据层。 */
function ResearchChainWorkflowStageBody({
  stage,
  nodes,
  details,
  selectedNodeId,
  loading,
  error,
  onSelectNode,
  actionSlot,
  detailSlot,
}: Props) {
  const { t, currentLocale } = useTranslation();
  const workbenchPeek = useResearchChainWorkbenchPeek();
  const recordPeek =
    workbenchPeek?.peek && workbenchPeek.peek.kind !== "task" && workbenchPeek.peek.kind !== "create"
      ? workbenchPeek.peek.kind
      : null;
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedDetail = details.find((detail) => detail.node.id === selectedNodeId) ?? null;
  const evidence = selectedDetail
    ? summarizeNodeEvidence(selectedDetail.node, selectedDetail.events, selectedDetail.snapshots)
    : { recordCount: 0, emptyCount: 0, emptyKeys: [] };
  const snapshots = selectedDetail?.snapshots ?? [];
  const events = selectedDetail?.events ?? [];
  const statusLabel = selectedNode
    ? t(`research.chains.node_status.${selectedNode.status.toLowerCase()}`)
    : stage.status === "NOT_STARTED"
      ? t("research.chains.workflow.not_started")
      : t(`research.chains.node_status.${stage.status.toLowerCase()}`);

  const closePeekRef = useRef(workbenchPeek?.close);
  closePeekRef.current = workbenchPeek?.close;
  useEffect(() => {
    closePeekRef.current?.();
  }, [selectedNodeId]);

  const openRecord = (kind: "evidence" | "snapshots" | "trace" | "empty") => {
    workbenchPeek?.openRecord(kind);
  };

  return (
    <section
      className="border-b border-subtle bg-surface-1"
      aria-label={t("research.chains.workflow.stage_detail_title")}
    >
      <div className="grid grid-cols-1 items-start xl:grid-cols-[220px_minmax(0,1fr)]">
        <div
          className="border-b border-subtle bg-surface-2 p-4 xl:border-r xl:border-b-0"
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
                  className={`flex w-full flex-col gap-0.5 border-l-2 px-3 py-2 text-left ${
                    selected ? "border-accent-primary bg-surface-1" : "border-transparent hover:bg-surface-1"
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
            {!nodes.length && <p className="px-3 text-12 text-tertiary">{t("research.chains.workflow.stage_empty")}</p>}
          </div>
        </div>

        <div className="min-w-0 bg-surface-1">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-subtle px-4 py-3">
            <div className="min-w-0">
              <h3 className="truncate text-16 font-semibold text-primary">
                {selectedNode?.title ?? t(stage.labelKey)}
              </h3>
              <p className="mt-1 text-12 text-secondary">{statusLabel}</p>
            </div>
            {actionSlot}
          </header>
          {selectedNode && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-subtle px-4 py-2 text-12">
              <CountButton
                label={t("research.chains.workflow.evidence")}
                count={evidence.recordCount}
                pressed={recordPeek === "evidence"}
                onClick={() => openRecord("evidence")}
              />
              <CountButton
                label={t("research.chains.snapshots_title")}
                count={snapshots.length}
                pressed={recordPeek === "snapshots"}
                onClick={() => openRecord("snapshots")}
              />
              <CountButton
                label={t("research.chains.workflow.trace_title")}
                count={events.length}
                pressed={recordPeek === "trace"}
                onClick={() => openRecord("trace")}
              />
              <CountButton
                label={t("research.chains.sections.empty_group")}
                count={evidence.emptyCount}
                pressed={recordPeek === "empty"}
                onClick={() => openRecord("empty")}
              />
            </div>
          )}
          {error && (
            <p className="border-b border-subtle px-4 py-3 text-12 text-danger-primary" role="alert">
              {t("research.chains.workflow.detail_load_failed")}
            </p>
          )}
          {detailSlot}
        </div>
      </div>
      {recordPeek && (
        <ResearchChainWorkbenchPeek
          title={t(
            `research.chains.workflow.peek_${recordPeek === "evidence" ? "evidence" : recordPeek === "snapshots" ? "snapshots" : recordPeek === "trace" ? "trace" : "empty"}`
          )}
          onClose={() => workbenchPeek?.close()}
        >
          {loading ? (
            <p className="text-12 text-tertiary">{t("research.common.loading")}</p>
          ) : recordPeek === "evidence" && selectedDetail ? (
            <ResearchChainNodeDetail {...selectedDetail} embedded />
          ) : recordPeek === "snapshots" ? (
            <SnapshotList snapshots={snapshots} nodeTitle={selectedNode?.title ?? ""} locale={currentLocale} />
          ) : recordPeek === "trace" ? (
            <TraceList events={events} />
          ) : (
            <ul className="space-y-1 text-12 text-tertiary" role="list">
              {evidence.emptyKeys.map((key) => (
                <li key={key}>{t(`research.chains.sections.${key}`)}</li>
              ))}
              {!evidence.emptyKeys.length && <li>{t("research.chains.sections.empty")}</li>}
            </ul>
          )}
        </ResearchChainWorkbenchPeek>
      )}
    </section>
  );
}

/**
 * 渲染工作台计数按钮。再次点击同一计数会关闭 Peek。
 */
function CountButton({
  label,
  count,
  pressed,
  onClick,
}: {
  label: string;
  count: number;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-peek-trigger=""
      aria-pressed={pressed || undefined}
      onClick={onClick}
      className={`rounded-sm px-1 py-0.5 ${pressed ? "font-medium text-primary" : "text-secondary hover:text-primary"}`}
    >
      {label} {count}
    </button>
  );
}

/**
 * 在 Peek 中列出当前节点的不可变快照。
 */
function SnapshotList({
  snapshots,
  nodeTitle,
  locale,
}: {
  snapshots: TResearchChainSnapshot[];
  nodeTitle: string;
  locale: string;
}) {
  const { t } = useTranslation();
  if (!snapshots.length) {
    return <p className="text-12 text-tertiary">{t("research.chains.workflow.stage_snapshot_empty")}</p>;
  }
  return (
    <ul className="divide-y divide-subtle" role="list">
      {snapshots.map((snapshot) => (
        <li key={`${snapshot.snapshot_id}-${snapshot.version}`} className="py-2 first:pt-0 last:pb-0">
          <p className="text-12 font-medium text-primary">
            {t(SNAPSHOT_TYPE_LABELS[snapshot.snapshot_type] ?? "research.chains.workflow.stage_snapshot")}·{" "}
            {t("research.chains.workflow.snapshot_version", { version: snapshot.version })}
          </p>
          <p className="mt-1 text-12 text-secondary">{snapshot.summary}</p>
          <p className="mt-1 text-11 text-tertiary">
            {nodeTitle} · {formatResearchDateTime(snapshot.created_at, locale)}
            {snapshot.source_versions.length
              ? ` · ${snapshot.source_versions.map(referenceLabel).filter(Boolean).join("、")}`
              : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * 在 Peek 中按时间列出当前节点的过程记录。
 */
function TraceList({ events }: { events: TResearchChainEvent[] }) {
  const { t, currentLocale } = useTranslation();
  if (!events.length) {
    return <p className="text-12 text-tertiary">{t("research.chains.workflow.trace_empty")}</p>;
  }
  return (
    <ol className="space-y-0 border-l border-subtle pl-4" role="list">
      {events.map((event) => (
        <li key={`${event.event_id}-${event.occurred_at}`} className="relative py-2 pl-4 first:pt-0 last:pb-0">
          <span className="bg-border-strong absolute top-[15px] -left-[21px] size-2 rounded-full" aria-hidden="true" />
          <p className="text-12 font-medium text-primary">{event.summary || event.event_type}</p>
          <p className="mt-1 text-11 text-tertiary">
            {formatResearchDateTime(event.occurred_at, currentLocale)} · {event.actor_type} · {event.source_system}
          </p>
          <p className="mt-0.5 truncate text-11 text-tertiary">
            {event.trace_id
              ? t("research.chains.workflow.trace_id", { id: event.trace_id })
              : t("research.chains.workflow.trace_id_empty")}
          </p>
        </li>
      ))}
    </ol>
  );
}
