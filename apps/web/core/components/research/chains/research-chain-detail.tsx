/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import type {
  TResearchChain,
  TResearchChainEvent,
  TResearchChainNode,
  TResearchChainNodeAction,
  TResearchChainSnapshot,
} from "@plane/types";
// hooks
import { useResearch } from "@/hooks/store/use-research";
// services
import { ResearchChainService } from "@/services/research/chain.service";
import { ResearchChainKnowledgePanel } from "@/components/research/chains/research-chain-knowledge-panel";

const chainService = new ResearchChainService();

type Props = {
  workspaceSlug: string;
  chainId: string;
};

type TNodeDetail = {
  node: TResearchChainNode;
  events: TResearchChainEvent[];
  snapshots: TResearchChainSnapshot[];
};

const ACTIONS_BY_STATUS: Record<TResearchChainNode["status"], TResearchChainNodeAction[]> = {
  DRAFT: ["START", "ARCHIVE"],
  ACTIVE: ["SUBMIT_REVIEW", "FAIL", "ARCHIVE"],
  WAITING_HUMAN: ["APPROVE", "RETURN"],
  NEEDS_REVISION: ["START", "ARCHIVE"],
  FAILED: ["START", "ARCHIVE"],
  COMPLETED: ["ARCHIVE"],
  ARCHIVED: [],
};

const NODE_TYPE_OPTIONS = [
  "RESEARCH",
  "LITERATURE_REVIEW",
  "TOPIC_EVALUATION",
  "PRE_EXPERIMENT",
  "PLAN",
  "OPENING",
  "EXPERIMENT",
  "ANALYSIS",
  "ITERATION",
  "SUMMARY",
  "PAPER_WRITING",
  "COMPLETION",
  "TRANSFER",
] as const;

/** Chain detail page: node lifecycle, append-only timeline and Agent entry. */
export const ResearchChainDetail = function ResearchChainDetail({ workspaceSlug, chainId }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const [chain, setChain] = useState<TResearchChain | null>(null);
  const [nodes, setNodes] = useState<TResearchChainNode[]>([]);
  const [selected, setSelected] = useState<TNodeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [nodeType, setNodeType] = useState("LITERATURE_REVIEW");
  const [nodeTitle, setNodeTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState("");
  const [transitioning, setTransitioning] = useState<string | null>(null);
  const [reasonByNode, setReasonByNode] = useState<Record<string, string>>({});
  const [reasonErrorByNode, setReasonErrorByNode] = useState<Record<string, string>>({});
  const [snapshotFilter, setSnapshotFilter] = useState("");
  const agentEnabled = Boolean(research.identity?.sections?.research_agent);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    setForbidden(false);
    setSelected(null);
    try {
      const [chainDetail, chainNodes] = await Promise.all([
        chainService.getChain(workspaceSlug, chainId),
        chainService.getChainNodes(workspaceSlug, chainId),
      ]);
      setChain(chainDetail);
      setNodes(chainNodes);
    } catch (error) {
      const errorCode = (error as { error_code?: string })?.error_code;
      setForbidden(errorCode === "research_permission_denied");
      setFailed(errorCode !== "research_permission_denied");
    } finally {
      setLoading(false);
    }
  }, [chainId, workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadNodeDetail = useCallback(
    async (nodeId: string) => {
      try {
        setSelected(await chainService.getChainNodeDetail(workspaceSlug, nodeId));
      } catch {
        setSelected(null);
      }
    },
    [workspaceSlug]
  );

  const createNode = async () => {
    if (!nodeTitle.trim() || creating) return;
    setCreating(true);
    setActionError("");
    try {
      await chainService.createChainNode(workspaceSlug, chainId, {
        node_type: nodeType,
        title: nodeTitle.trim(),
      });
      setNodeTitle("");
      await load();
    } catch {
      setActionError(t("research.chains.action_failed"));
    } finally {
      setCreating(false);
    }
  };

  const transition = async (node: TResearchChainNode, action: TResearchChainNodeAction) => {
    const reason = reasonByNode[node.id]?.trim();
    if ((action === "FAIL" || action === "RETURN") && !reason) {
      setReasonErrorByNode((current) => ({ ...current, [node.id]: t("research.chains.reason_required") }));
      return;
    }
    setReasonErrorByNode((current) => {
      if (!current[node.id]) return current;
      const next = { ...current };
      delete next[node.id];
      return next;
    });
    setTransitioning(node.id);
    setActionError("");
    try {
      await chainService.transitionChainNode(workspaceSlug, node.id, action, reason);
      await load();
      await loadNodeDetail(node.id);
    } catch {
      setActionError(t("research.chains.action_failed"));
    } finally {
      setTransitioning(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-2 p-5" role="status" aria-busy="true">
        {[0, 1].map((row) => (
          <div key={row} className="h-12 animate-pulse rounded-md bg-surface-2" />
        ))}
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="p-5">
        <p className="rounded-lg border border-subtle bg-surface-1 p-6 text-13 text-primary" role="alert">
          {t("research.common.permission_denied")}
        </p>
      </div>
    );
  }

  if (failed) {
    return (
      <div className="p-5">
        <p className="text-13 text-primary">{t("research.status.load_failed.title")}</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-3 rounded-md border border-subtle px-3 py-1.5 text-12 text-secondary hover:bg-surface-2"
        >
          {t("research.chains.refresh")}
        </button>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-5">
      <section className="rounded-lg border border-subtle bg-surface-1 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-13 font-medium text-primary">{t("research.chains.create_node_title")}</h3>
            <p className="mt-1 text-11 text-tertiary">
              {chain?.status} · {chain?.visibility}
            </p>
          </div>
          {chain && (
            <span className="rounded bg-surface-2 px-2 py-1 text-11 text-tertiary">
              {new Date(chain.updated_at).toLocaleString()}
            </span>
          )}
        </div>
        {actionError && (
          <p className="mt-3 text-11 text-danger-primary" role="alert">
            {actionError}
          </p>
        )}
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto]">
          <label className="flex flex-col gap-1 text-12 text-secondary">
            <span>{t("research.chains.node_type")}</span>
            <select
              value={nodeType}
              onChange={(event) => setNodeType(event.target.value)}
              aria-label={t("research.chains.node_type")}
              className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 text-primary outline-none"
            >
              {NODE_TYPE_OPTIONS.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-12 text-secondary">
            <span>{t("research.chains.node_title")}</span>
            <input
              value={nodeTitle}
              onChange={(event) => setNodeTitle(event.target.value)}
              placeholder={t("research.chains.node_title_placeholder")}
              className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13 text-primary outline-none"
            />
          </label>
          <button
            type="button"
            onClick={() => void createNode()}
            disabled={!nodeTitle.trim() || creating}
            className="mt-auto rounded-md bg-accent-primary px-3 py-2 text-12 text-on-color disabled:opacity-50"
          >
            {t("research.chains.create_node")}
          </button>
        </div>
      </section>

      {nodes.length === 0 ? (
        <p className="mt-4 rounded-lg border border-subtle bg-surface-1 p-6 text-13 text-primary" role="status">
          {t("research.chains.nodes_empty")}
        </p>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          <ul className="space-y-2" role="list">
            {nodes.map((node) => (
              <li key={node.id} className="rounded-lg border border-subtle bg-surface-1 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-13 font-medium text-primary">{node.title}</p>
                    <p className="mt-1 text-11 text-tertiary">
                      {node.node_type} · {node.status}
                      {node.loop_iteration ? ` · #${node.loop_iteration}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void loadNodeDetail(node.id)}
                      className="rounded-md border border-subtle px-3 py-1.5 text-12 text-secondary hover:bg-surface-2"
                    >
                      {t("research.chains.open_timeline")}
                    </button>
                    {agentEnabled && (
                      <Link
                        href={`/${workspaceSlug}/research/chains/${chainId}/nodes/${node.id}/agent`}
                        className="rounded-md bg-accent-primary px-3 py-1.5 text-12 text-on-color"
                      >
                        {t("research.chains.open_agent")}
                      </Link>
                    )}
                  </div>
                </div>
                {ACTIONS_BY_STATUS[node.status].length > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {ACTIONS_BY_STATUS[node.status].map((action) => (
                      <button
                        key={action}
                        type="button"
                        onClick={() => void transition(node, action)}
                        disabled={transitioning === node.id}
                        className="rounded-md border border-subtle px-2.5 py-1 text-11 text-secondary hover:bg-surface-2 disabled:opacity-50"
                      >
                        {t(`research.chains.action_${action.toLowerCase()}`)}
                      </button>
                    ))}
                  </div>
                )}
                {(node.status === "ACTIVE" || node.status === "WAITING_HUMAN") && (
                  <label className="mt-3 flex flex-col gap-1 text-11 text-tertiary">
                    <span>{t("research.chains.reason_label")}</span>
                    <input
                      value={reasonByNode[node.id] ?? ""}
                      aria-invalid={Boolean(reasonErrorByNode[node.id])}
                      aria-describedby={reasonErrorByNode[node.id] ? `reason-error-${node.id}` : undefined}
                      onChange={(event) => {
                        const value = event.target.value;
                        setReasonByNode({ ...reasonByNode, [node.id]: value });
                        if (value.trim()) {
                          setReasonErrorByNode((current) => {
                            if (!current[node.id]) return current;
                            const next = { ...current };
                            delete next[node.id];
                            return next;
                          });
                        }
                      }}
                      className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary outline-none"
                    />
                    {reasonErrorByNode[node.id] && (
                      <span id={`reason-error-${node.id}`} className="text-11 text-danger-primary" role="alert">
                        {reasonErrorByNode[node.id]}
                      </span>
                    )}
                  </label>
                )}
              </li>
            ))}
          </ul>

          <aside className="rounded-lg border border-subtle bg-surface-1 p-4">
            {selected && (
              <div className="mb-4">
                <ResearchChainKnowledgePanel
                  workspaceSlug={workspaceSlug}
                  chainId={chainId}
                  nodeId={selected.node.id}
                />
              </div>
            )}
            <h3 className="text-13 font-medium text-primary">{t("research.chains.timeline_title")}</h3>
            {!selected ? (
              <p className="mt-2 text-12 text-tertiary">{t("research.chains.timeline_empty")}</p>
            ) : (
              <div className="mt-3 space-y-4">
                <section>
                  <h4 className="text-11 font-medium text-secondary">{t("research.chains.events_title")}</h4>
                  <ol className="mt-2 space-y-2" role="list">
                    {selected.events.map((event) => (
                      <li key={event.event_id} className="rounded-md border border-subtle bg-surface-1 p-3">
                        <p className="text-11 font-medium text-primary">{event.event_type}</p>
                        <p className="mt-1 text-11 text-tertiary">{event.summary || event.content_hash}</p>
                      </li>
                    ))}
                  </ol>
                </section>
                <section>
                  <h4 className="text-11 font-medium text-secondary">{t("research.chains.snapshots_title")}</h4>
                  <select
                    value={snapshotFilter}
                    onChange={(event) => setSnapshotFilter(event.target.value)}
                    aria-label={t("research.chains.snapshot_filter")}
                    className="mt-2 w-full rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-11 text-primary"
                  >
                    <option value="">{t("research.chains.snapshot_filter_all")}</option>
                    {[
                      "LITERATURE_REVIEW",
                      "EXPERIMENT_EXECUTION",
                      "EXPERIMENT_DATA",
                      "ANALYSIS_RESULT",
                      "PAPER_RESEARCH",
                      "PROCESS",
                    ].map((type) => (
                      <option key={type} value={type}>
                        {t(`research.chains.snapshot_type_${type.toLowerCase()}`)}
                      </option>
                    ))}
                  </select>
                  <ul className="mt-2 space-y-2" role="list">
                    {selected.snapshots
                      .filter((snapshot) => !snapshotFilter || snapshot.snapshot_type === snapshotFilter)
                      .map((snapshot) => (
                        <li key={snapshot.snapshot_id} className="rounded-md border border-subtle bg-surface-1 p-3">
                          <p className="text-11 font-medium text-primary">
                            {t(`research.chains.snapshot_type_${snapshot.snapshot_type.toLowerCase()}`)} · v
                            {snapshot.version}
                          </p>
                          <p className="mt-1 text-11 text-tertiary">{snapshot.summary}</p>
                        </li>
                      ))}
                  </ul>
                </section>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
};
