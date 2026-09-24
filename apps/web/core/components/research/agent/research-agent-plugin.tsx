"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TResearchAgentSession } from "@plane/types";
// components
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
// services
import {
  ResearchAgentService,
  type TAgentApprovalDecision,
  type TAgentRunEvent,
} from "@/services/research/agent.service";

const agentService = new ResearchAgentService();

type Props = {
  workspaceSlug: string;
  chainNodeId: string;
};

type TPluginState =
  | "loading_context"
  | "ready"
  | "streaming"
  | "waiting_approval"
  | "degraded"
  | "forbidden"
  | "error"
  | "closed";

type TToolStatus = "READY" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "FAILED" | "DEGRADED";
type TRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
type TTranslate = (key: string, params?: Record<string, unknown>) => string;

const EVENT_TYPE_LABELS: Record<string, string> = {
  AI_ACTION: "research.agent.event_ai_action",
  DATA_CHANGE: "research.agent.event_data_change",
  INTERMEDIATE_ARTIFACT: "research.agent.event_intermediate_artifact",
  VALIDATION: "research.agent.event_validation",
  VALIDATION_PASSED: "research.agent.event_validation_passed",
  VALIDATION_FAILED: "research.agent.event_validation_failed",
  HUMAN_DECISION: "research.agent.event_human_decision",
  APPROVAL: "research.agent.event_approval",
  DEGRADED: "research.agent.event_degraded",
  OUTPUT: "research.agent.event_output",
  NODE_CREATED: "research.agent.event_node_created",
};

/** Merge Agent events by the stable `(run_id, seq)` cursor. */
function mergeEvents(current: TAgentRunEvent[], incoming: TAgentRunEvent[]) {
  const merged = new Map(current.map((event) => [`${event.run_id}:${event.seq}`, event]));
  for (const event of incoming) merged.set(`${event.run_id}:${event.seq}`, event);
  // eslint-disable-next-line unicorn/no-array-sort
  return [...merged.values()].sort((left, right) => left.seq - right.seq);
}

/** Read the first human-readable string from known payload fields. */
function payloadText(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/** Normalize tool status while preventing unknown backend codes from reaching the UI. */
function toolStatus(payload: Record<string, unknown>): TToolStatus {
  const value = String(payload.status ?? payload.state ?? "").toUpperCase();
  if (value === "PENDING" || value === "WAITING" || value === "WAITING_APPROVAL") return "WAITING_APPROVAL";
  if (value === "RUNNING" || value === "STREAMING") return "RUNNING";
  if (value === "SUCCESS" || value === "COMPLETED" || value === "READY") return "COMPLETED";
  if (value === "FAILED" || value === "ERROR") return "FAILED";
  if (value === "DEGRADED") return "DEGRADED";
  return "READY";
}

/** Normalize risk levels for structured tool cards. */
function riskLevel(payload: Record<string, unknown>): TRiskLevel {
  const value = String(payload.risk_level ?? payload.risk ?? "").toUpperCase();
  if (value === "LOW" || value === "MEDIUM" || value === "HIGH") return value;
  return "UNKNOWN";
}

/** Translate known event types and collapse unknown codes into a stable label. */
function eventLabel(eventType: string, t: TTranslate) {
  const key = EVENT_TYPE_LABELS[eventType.toUpperCase()];
  return t(key ?? "research.agent.event_unknown");
}

/** Extract readable references without dumping raw JSON arrays. */
function payloadReferences(payload: Record<string, unknown>, keys: string[]) {
  return keys
    .flatMap((key) => {
      const value = payload[key];
      if (Array.isArray(value)) {
        return value.map((item) =>
          typeof item === "string"
            ? item
            : (["title", "name", "summary", "source", "url"]
                .map((field) => (item as Record<string, unknown>)?.[field])
                .find((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate)) ?? "")
        );
      }
      return typeof value === "string" ? [value] : [];
    })
    .filter(Boolean)
    .slice(0, 4);
}

/** Derive a stable UI state from the authoritative Agent session. */
function sessionState(session: TResearchAgentSession): TPluginState {
  if (session.status === "WAITING_APPROVAL") return "waiting_approval";
  if (session.status === "STREAMING" || session.status === "SAVING") return "streaming";
  if (session.status === "DEGRADED") return "degraded";
  if (session.status === "ERROR") return "error";
  if (session.status === "CLOSED") return "closed";
  return "ready";
}

/** Same-origin Research Agent workbench with structured cards, drawers and trace filters. */
export const ResearchAgentPlugin = function ResearchAgentPlugin({ workspaceSlug, chainNodeId }: Props) {
  const { t } = useTranslation();
  const [session, setSession] = useState<TResearchAgentSession | null>(null);
  const [events, setEvents] = useState<TAgentRunEvent[]>([]);
  const [state, setState] = useState<TPluginState>("loading_context");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [artifactDrawerOpen, setArtifactDrawerOpen] = useState(false);
  const [artifactDraft, setArtifactDraft] = useState("");
  const [artifactType, setArtifactType] = useState("ANALYSIS_SUMMARY");
  const [artifactConfirmed, setArtifactConfirmed] = useState(false);
  const [savingArtifact, setSavingArtifact] = useState(false);
  const [savedArtifact, setSavedArtifact] = useState<string | null>(null);
  const [artifactError, setArtifactError] = useState("");
  const [approvalFor, setApprovalFor] = useState<TAgentRunEvent | null>(null);
  const [approvalReason, setApprovalReason] = useState("");
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [approvalResult, setApprovalResult] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const [traceTypeFilter, setTraceTypeFilter] = useState("");
  const [traceStatusFilter, setTraceStatusFilter] = useState("");
  const sessionRef = useRef<TResearchAgentSession | null>(null);
  const approvalDrawerRef = useRef<HTMLDivElement | null>(null);
  const artifactDrawerRef = useRef<HTMLDivElement | null>(null);
  const approvalRequestIdsRef = useRef<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    setState("loading_context");
    setEvents([]);
    setMessage("");
    setArtifactDraft("");
    setArtifactConfirmed(false);
    setSavedArtifact(null);
    setArtifactError("");
    setApprovalFor(null);
    setApprovalResult("");
    setApprovalError("");

    const closeQuietly = async (value: TResearchAgentSession | null) => {
      if (!value || value.status === "CLOSED") return;
      try {
        await agentService.cancelRun(workspaceSlug, value.run_id);
      } catch {
        // Closing is best-effort when the browser leaves or switches scope.
      }
    };

    const start = async () => {
      try {
        const created = await agentService.createSession(workspaceSlug, chainNodeId);
        const initial = await agentService.getEvents(workspaceSlug, created.run_id).catch(() => null);
        if (!active) return;
        sessionRef.current = created;
        setSession(created);
        setEvents(mergeEvents([], initial?.results ?? []));
        setState(sessionState(created));
      } catch {
        if (!active) return;
        sessionRef.current = null;
        setSession(null);
        setState("forbidden");
      }
    };

    const previous = sessionRef.current;
    if (previous) void closeQuietly(previous);
    void start();

    return () => {
      active = false;
      void closeQuietly(sessionRef.current);
    };
  }, [chainNodeId, workspaceSlug]);

  useEffect(() => {
    const drawer = approvalFor ? approvalDrawerRef.current : artifactDrawerOpen ? artifactDrawerRef.current : null;
    drawer?.focus();
  }, [approvalFor, artifactDrawerOpen]);

  useEffect(() => {
    if (!approvalFor && !artifactDrawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setApprovalFor(null);
        setArtifactDrawerOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [approvalFor, artifactDrawerOpen]);

  const latestSeq = useMemo(() => events.at(-1)?.seq ?? 0, [events]);
  const toolEvents = useMemo(() => events.filter((event) => event.event_type.toUpperCase().includes("TOOL")), [events]);
  const artifactEvents = useMemo(
    () => events.filter((event) => ["DATA_CHANGE", "INTERMEDIATE_ARTIFACT", "OUTPUT"].includes(event.event_type)),
    [events]
  );
  const approvalEvents = useMemo(
    () =>
      toolEvents.filter(
        (event) => event.payload.requires_approval === true || toolStatus(event.payload) === "WAITING_APPROVAL"
      ),
    [toolEvents]
  );
  const activeApproval =
    approvalFor ??
    (session?.status === "WAITING_APPROVAL" ? (approvalEvents.at(-1) ?? toolEvents.at(-1) ?? null) : null);
  const traceTypes = useMemo(() => [...new Set(events.map((event) => event.event_type))], [events]);
  const traceStatuses = useMemo(() => [...new Set(events.map((event) => toolStatus(event.payload)))], [events]);
  const visibleEvents = useMemo(
    () =>
      events.filter(
        (event) =>
          (!traceTypeFilter || event.event_type === traceTypeFilter) &&
          (!traceStatusFilter || toolStatus(event.payload) === traceStatusFilter)
      ),
    [events, traceStatusFilter, traceTypeFilter]
  );

  const close = async () => {
    if (!session) return;
    try {
      const closed = await agentService.closeSession(workspaceSlug, session.session_id);
      sessionRef.current = closed;
      setSession(closed);
      setState("closed");
    } catch {
      setState("error");
    }
  };

  const stop = async () => {
    if (!session) return;
    try {
      const cancelled = await agentService.cancelRun(workspaceSlug, session.run_id);
      sessionRef.current = cancelled;
      setSession(cancelled);
      setState("closed");
    } catch {
      setState("error");
    }
  };

  const reconnect = useCallback(async () => {
    if (!session || reconnecting) return;
    setReconnecting(true);
    try {
      const result = await agentService.getEvents(workspaceSlug, session.run_id, latestSeq);
      setEvents((current) => mergeEvents(current, result.results));
      setState(sessionState(session));
    } catch {
      setState("degraded");
    } finally {
      setReconnecting(false);
    }
  }, [latestSeq, reconnecting, session, workspaceSlug]);

  const send = async () => {
    if (!session || !message.trim() || sending) return;
    setSending(true);
    setState("streaming");
    try {
      const response = await agentService.sendMessage(workspaceSlug, session.session_id, message.trim());
      sessionRef.current = response.session;
      setSession(response.session);
      setEvents((current) => mergeEvents(current, response.events));
      setState(sessionState(response.session));
      setMessage("");
    } catch {
      setState("error");
    } finally {
      setSending(false);
    }
  };

  const saveArtifact = async () => {
    if (!session || !artifactDraft.trim() || !artifactConfirmed || savingArtifact) return;
    setSavingArtifact(true);
    setArtifactError("");
    try {
      const result = await agentService.saveArtifact(workspaceSlug, session.session_id, {
        artifact_type: artifactType,
        summary: artifactDraft.trim(),
        confirmed: artifactConfirmed,
        method: "AI assisted analysis",
      });
      setSavedArtifact(
        result?.snapshot_id ? `${result.snapshot_type} v${result.version}` : `DRAFT ${result?.analysis_id ?? ""}`
      );
      if (result?.event) setEvents((current) => mergeEvents(current, [result.event]));
      setArtifactDraft("");
      setArtifactConfirmed(false);
    } catch {
      setArtifactError(t("research.agent.artifact_error"));
    } finally {
      setSavingArtifact(false);
    }
  };

  const decideApproval = async (decision: TAgentApprovalDecision) => {
    if (!session || !activeApproval || approvalBusy) return;
    setApprovalBusy(true);
    setApprovalError("");
    try {
      const key = `${activeApproval.run_id}:${activeApproval.seq}:${decision}`;
      if (!approvalRequestIdsRef.current[key]) {
        approvalRequestIdsRef.current[key] =
          globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      }
      const result = await agentService.decideApproval(workspaceSlug, session.run_id, {
        request_id: approvalRequestIdsRef.current[key],
        decision,
        tool_call_id: String(activeApproval.payload.tool_call_id ?? activeApproval.seq),
        reason: approvalReason.trim() || undefined,
      });
      sessionRef.current = result.session;
      setSession(result.session);
      setEvents((current) => mergeEvents(current, [result.event]));
      setState(sessionState(result.session));
      setApprovalResult(
        decision === "APPROVED" ? t("research.agent.approval_approved") : t("research.agent.approval_rejected")
      );
    } catch {
      setApprovalError(t("research.agent.approval_error"));
    } finally {
      setApprovalBusy(false);
    }
  };

  const jumpToEvent = (seq: number) => {
    setTraceTypeFilter("");
    setTraceStatusFilter("");
    queueMicrotask(() => {
      document.getElementById(`event-${seq}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  const statusKey = session ? `research.agent.status.${session.status}` : undefined;
  const authorizedResourceCount =
    (session?.assembly.allowed_knowledge_base_ids.length ?? 0) + (session?.assembly.allowed_file_ids.length ?? 0);

  return (
    <section className="flex h-full flex-col overflow-hidden" aria-label={t("research.agent.description")}>
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-subtle bg-surface-1 px-5 py-3">
        <div className="min-w-0">
          <p className="text-13 font-semibold text-primary">{t("research.agent.context_summary")}</p>
          <p className="mt-1 truncate text-11 text-secondary">
            {session?.project_name ?? session?.project ?? "-"} · {session?.chain_node_title ?? chainNodeId}
          </p>
          <p className="mt-0.5 truncate text-11 text-tertiary">
            {t("research.agent.resource_count", { count: authorizedResourceCount })}
            {session?.context_expires_at &&
              ` · ${t("research.agent.context_expires", {
                time: new Date(session.context_expires_at).toLocaleString(),
              })}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ResearchStatusBadge status={session?.status ?? "unknown"}>
            {statusKey ? t(statusKey) : t("research.agent.no_session")}
          </ResearchStatusBadge>
          <span className="rounded-md border border-subtle px-2 py-1 text-11 text-tertiary">
            {t("research.agent.last_seq", { seq: latestSeq })}
          </span>
          {activeApproval && (
            <Button variant="primary" size="base" onClick={() => setApprovalFor(activeApproval)}>
              {t("research.agent.open_approval")}
            </Button>
          )}
          <Button variant="secondary" size="base" onClick={() => setArtifactDrawerOpen(true)}>
            {t("research.agent.open_artifact")}
          </Button>
          <Button variant="secondary" size="base" onClick={() => void reconnect()} disabled={!session || reconnecting}>
            {t("research.agent.reconnect")}
          </Button>
          {(state === "closed" || state === "error") && (
            <Button variant="secondary" size="base" onClick={() => window.location.reload()}>
              {t("research.agent.reload_context")}
            </Button>
          )}
          <Button
            variant="secondary"
            size="base"
            onClick={() => void stop()}
            disabled={!session || session.status === "CLOSED" || sending}
          >
            {t("research.agent.stop")}
          </Button>
          <Button
            variant="secondary"
            size="base"
            onClick={() => void close()}
            disabled={!session || session.status === "CLOSED"}
          >
            {t("research.agent.close")}
          </Button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="flex min-h-0 flex-col">
          <div className="border-b border-subtle px-5 py-3">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <section>
                <h3 className="text-11 font-semibold text-secondary">{t("research.agent.assembly_available")}</h3>
                <ul className="mt-2 space-y-1 text-11 text-secondary" role="list">
                  <li>{session?.assembly.persona ?? "-"}</li>
                  {(session?.assembly.allowed_tools ?? []).map((tool) => (
                    <li key={tool}>{tool}</li>
                  ))}
                </ul>
              </section>
              <section>
                <h3 className="text-11 font-semibold text-secondary">{t("research.agent.assembly_confirmation")}</h3>
                <p className="mt-2 text-11 text-secondary">
                  {session?.assembly.policy_id
                    ? t("research.agent.policy_confirmation", { policy: session.assembly.policy_id })
                    : t("research.agent.assembly_no_confirmation")}
                </p>
              </section>
              <section>
                <h3 className="text-11 font-semibold text-secondary">{t("research.agent.assembly_unavailable")}</h3>
                <ul className="mt-2 space-y-1 text-11 text-secondary" role="list">
                  {(session?.assembly.unavailable_reasons ?? []).map((reason) => (
                    <li key={reason}>{t(`research.agent.reasons.${reason}`)}</li>
                  ))}
                  {!(session?.assembly.unavailable_reasons ?? []).length && (
                    <li>{t("research.agent.assembly_all_available")}</li>
                  )}
                </ul>
              </section>
            </div>
          </div>

          <div className="flex-1 space-y-2 p-5" role="log" aria-live="polite">
            {state === "loading_context" && <p className="text-12 text-tertiary">{t("research.agent.description")}</p>}
            {state === "forbidden" && <p className="text-12 text-primary">{t("research.common.permission_denied")}</p>}
            {state === "degraded" && <p className="text-12 text-primary">{t("research.agent.degraded")}</p>}
            {!session && state !== "loading_context" && state !== "forbidden" && (
              <p className="text-12 text-tertiary">{t("research.agent.no_session")}</p>
            )}
            {events.map((event) => {
              const narrative = payloadText(event.payload, ["reasoning", "summary", "content", "message", "text"]);
              const sources = payloadReferences(event.payload, ["sources", "references", "refs", "citations"]);
              return (
                <article
                  key={`${event.run_id}:${event.seq}`}
                  id={`event-${event.seq}`}
                  className="relative border-l-2 border-subtle py-2 pl-4 text-12 text-secondary transition-colors hover:border-strong"
                >
                  <p className="font-medium text-primary">
                    {eventLabel(event.event_type, t)} · #{event.seq}
                  </p>
                  {narrative && <p className="mt-1 text-11 text-secondary">{narrative}</p>}
                  {sources.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-11 text-tertiary" role="list">
                      {sources.map((source) => (
                        <li key={source}>{source}</li>
                      ))}
                    </ul>
                  )}
                </article>
              );
            })}
          </div>

          <form
            className="border-t border-subtle p-4"
            onSubmit={(formEvent) => {
              formEvent.preventDefault();
              void send();
            }}
          >
            <label htmlFor="research-agent-message" className="text-11 font-medium text-secondary">
              {t("research.agent.input_label")}
            </label>
            <textarea
              id="research-agent-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={t("research.agent.input_placeholder")}
              rows={3}
              className="focus:border-accent-primary mt-2 w-full resize-none rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary outline-none"
              disabled={!session || session.status === "CLOSED" || sending}
            />
            <button
              type="submit"
              disabled={!session || session.status === "CLOSED" || sending || !message.trim()}
              className="mt-2 rounded-md bg-accent-primary px-3 py-1.5 text-12 text-on-color disabled:opacity-50"
            >
              {sending ? t("research.agent.status.STREAMING") : t("research.agent.send")}
            </button>
          </form>
        </div>

        <aside className="min-h-0 border-subtle xl:border-l">
          <section className="border-b border-subtle p-4">
            <h3 className="text-12 font-semibold text-primary">{t("research.agent.tools_title")}</h3>
            {toolEvents.length ? (
              <ul className="mt-2 space-y-2" role="list">
                {toolEvents.map((event) => {
                  const status = toolStatus(event.payload);
                  const risk = riskLevel(event.payload);
                  const toolName =
                    payloadText(event.payload, ["tool_name", "tool", "name", "capability"]) ||
                    eventLabel(event.event_type, t);
                  const scope = payloadText(event.payload, ["capability_scope", "scope", "scope_id"]);
                  const input = payloadText(event.payload, ["input_summary", "query", "input", "prompt"]);
                  const outputs = payloadReferences(event.payload, ["output_refs", "output", "references"]);
                  return (
                    <li
                      key={`tool-${event.run_id}-${event.seq}`}
                      id={`tool-${event.seq}`}
                      className="rounded-lg border border-subtle bg-surface-1 p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-11 font-semibold text-primary">{toolName}</p>
                        <ResearchStatusBadge status={status} size="sm">
                          {t(`research.agent.tool_status.${status.toLowerCase()}`)}
                        </ResearchStatusBadge>
                      </div>
                      <dl className="mt-2 space-y-1 text-11">
                        {scope && (
                          <div className="flex gap-2">
                            <dt className="text-tertiary">{t("research.agent.tool_scope")}</dt>
                            <dd className="min-w-0 flex-1 break-words text-secondary">{scope}</dd>
                          </div>
                        )}
                        <div className="flex gap-2">
                          <dt className="text-tertiary">{t("research.agent.tool_risk")}</dt>
                          <dd className="text-secondary">{t(`research.agent.risk.${risk.toLowerCase()}`)}</dd>
                        </div>
                        {input && (
                          <div className="flex gap-2">
                            <dt className="text-tertiary">{t("research.agent.tool_input")}</dt>
                            <dd className="min-w-0 flex-1 break-words text-secondary">{input}</dd>
                          </div>
                        )}
                        {outputs.length > 0 && (
                          <div className="flex gap-2">
                            <dt className="text-tertiary">{t("research.agent.tool_output")}</dt>
                            <dd className="min-w-0 flex-1 break-words text-secondary">{outputs.join("；")}</dd>
                          </div>
                        )}
                      </dl>
                      <button
                        type="button"
                        onClick={() => jumpToEvent(event.seq)}
                        className="mt-2 text-11 text-accent-primary hover:underline"
                      >
                        {t("research.agent.open_trace")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="mt-2 text-11 text-tertiary">{t("research.agent.tools_empty")}</p>
            )}
          </section>

          <section className="border-b border-subtle p-4">
            <h3 className="text-12 font-semibold text-primary">{t("research.agent.artifacts_title")}</h3>
            <button
              type="button"
              onClick={() => setArtifactDrawerOpen(true)}
              className="mt-2 rounded-md border border-subtle px-3 py-1.5 text-11 text-secondary hover:bg-surface-2"
            >
              {t("research.agent.open_artifact")}
            </button>
            <ul className="mt-3 space-y-2" role="list">
              {artifactEvents.map((event) => {
                const summary = payloadText(event.payload, ["summary", "content", "artifact_type", "action"]);
                return (
                  <li key={`artifact-${event.run_id}-${event.seq}`} className="rounded-md border border-subtle p-3">
                    <p className="text-11 font-medium text-primary">{eventLabel(event.event_type, t)}</p>
                    {summary && <p className="mt-1 text-11 text-secondary">{summary}</p>}
                  </li>
                );
              })}
              {!artifactEvents.length && (
                <li className="text-11 text-tertiary">{t("research.agent.artifacts_empty")}</li>
              )}
            </ul>
          </section>

          <section className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-12 font-semibold text-primary">{t("research.agent.trace_title")}</h3>
              <div className="flex flex-wrap gap-2">
                <select
                  value={traceTypeFilter}
                  onChange={(event) => setTraceTypeFilter(event.target.value)}
                  aria-label={t("research.agent.trace_type_filter")}
                  className="rounded-md border border-subtle bg-surface-1 px-2 py-1 text-11 text-primary"
                >
                  <option value="">{t("research.agent.trace_all_types")}</option>
                  {traceTypes.map((type) => (
                    <option key={type} value={type}>
                      {eventLabel(type, t)}
                    </option>
                  ))}
                </select>
                <select
                  value={traceStatusFilter}
                  onChange={(event) => setTraceStatusFilter(event.target.value)}
                  aria-label={t("research.agent.trace_status_filter")}
                  className="rounded-md border border-subtle bg-surface-1 px-2 py-1 text-11 text-primary"
                >
                  <option value="">{t("research.agent.trace_all_statuses")}</option>
                  {traceStatuses.map((status) => (
                    <option key={status} value={status}>
                      {t(`research.agent.tool_status.${status.toLowerCase()}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <ol className="mt-3 space-y-2" role="list">
              {visibleEvents.map((event) => (
                <li
                  key={`trace-${event.run_id}-${event.seq}`}
                  className="flex items-center justify-between gap-2 text-11"
                >
                  <span className="min-w-0 truncate text-tertiary">
                    <span className="font-medium text-secondary">#{event.seq}</span> {eventLabel(event.event_type, t)}
                  </span>
                  <button
                    type="button"
                    onClick={() => jumpToEvent(event.seq)}
                    className="shrink-0 text-accent-primary hover:underline"
                  >
                    {t("research.agent.open_trace")}
                  </button>
                </li>
              ))}
              {!visibleEvents.length && <li className="text-11 text-tertiary">{t("research.agent.trace_empty")}</li>}
            </ol>
          </section>
        </aside>
      </div>

      {activeApproval && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t("research.agent.close_drawer")}
            onClick={() => setApprovalFor(null)}
            className="fixed inset-0 z-40 bg-black/20"
          />
          <div
            ref={approvalDrawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("research.agent.approval_drawer")}
            tabIndex={-1}
            className="fixed top-0 right-0 z-50 flex h-full w-full max-w-md flex-col border-l border-subtle bg-surface-1 outline-none"
          >
            <div className="flex items-center justify-between border-b border-subtle px-4 py-3">
              <h3 className="text-13 font-semibold text-primary">{t("research.agent.approval_drawer")}</h3>
              <button
                type="button"
                onClick={() => setApprovalFor(null)}
                className="rounded-md px-2 py-1 text-12 text-secondary hover:bg-surface-2"
              >
                {t("research.agent.close_drawer")}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <p className="text-12 font-medium text-primary">
                {payloadText(activeApproval.payload, ["tool_name", "tool", "name", "capability"]) ||
                  activeApproval.event_type}
              </p>
              <p className="mt-1 text-12 text-secondary">
                {payloadText(activeApproval.payload, ["input_summary", "query", "input", "prompt"]) ||
                  t("research.agent.approval_scope_hint")}
              </p>
              <label className="mt-4 flex flex-col gap-1 text-11 text-secondary">
                {t("research.agent.approval_reason")}
                <textarea
                  value={approvalReason}
                  onChange={(event) => setApprovalReason(event.target.value)}
                  rows={4}
                  className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
                />
              </label>
              {approvalResult && <p className="mt-3 text-12 text-success-primary">{approvalResult}</p>}
              {approvalError && (
                <p className="mt-3 text-12 text-danger-primary" role="alert">
                  {approvalError}
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-subtle px-4 py-3">
              <button
                type="button"
                onClick={() => void decideApproval("REJECTED")}
                disabled={approvalBusy}
                className="rounded-md border border-danger-strong/40 px-3 py-1.5 text-12 text-danger-primary disabled:opacity-50"
              >
                {t("research.approvals.reject")}
              </button>
              <button
                type="button"
                onClick={() => void decideApproval("APPROVED")}
                disabled={approvalBusy}
                className="rounded-md bg-accent-primary px-3 py-1.5 text-12 text-on-color disabled:opacity-50"
              >
                {approvalBusy ? t("research.agent.status.SAVING") : t("research.approvals.approve")}
              </button>
            </div>
          </div>
        </>
      )}

      {artifactDrawerOpen && (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t("research.agent.close_drawer")}
            onClick={() => setArtifactDrawerOpen(false)}
            className="fixed inset-0 z-40 bg-black/20"
          />
          <div
            ref={artifactDrawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={t("research.agent.artifact_drawer")}
            tabIndex={-1}
            className="fixed top-0 right-0 z-50 flex h-full w-full max-w-md flex-col border-l border-subtle bg-surface-1 outline-none"
          >
            <div className="flex items-center justify-between border-b border-subtle px-4 py-3">
              <h3 className="text-13 font-semibold text-primary">{t("research.agent.artifact_drawer")}</h3>
              <button
                type="button"
                onClick={() => setArtifactDrawerOpen(false)}
                className="rounded-md px-2 py-1 text-12 text-secondary hover:bg-surface-2"
              >
                {t("research.agent.close_drawer")}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <label className="flex flex-col gap-1 text-11 text-secondary">
                {t("research.agent.artifact_preview")}
                <textarea
                  value={artifactDraft}
                  onChange={(event) => setArtifactDraft(event.target.value)}
                  placeholder={t("research.agent.artifact_placeholder")}
                  rows={10}
                  className="w-full resize-none rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
                />
              </label>
              <label className="mt-3 flex flex-col gap-1 text-11 text-secondary">
                {t("research.agent.artifact_type")}
                <select
                  value={artifactType}
                  onChange={(event) => setArtifactType(event.target.value)}
                  className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-11 text-primary"
                >
                  {[
                    "RESEARCH_PLAN_DRAFT",
                    "LITERATURE_REFERENCE",
                    "EXPERIMENT_RECORD",
                    "EXPERIMENT_DATA",
                    "ANALYSIS_SUMMARY",
                    "PROCESS_NOTE",
                  ].map((type) => (
                    <option key={type} value={type}>
                      {t(`research.agent.artifact_type_${type.toLowerCase()}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="mt-3 flex items-center gap-2 text-11 text-secondary">
                <input
                  type="checkbox"
                  checked={artifactConfirmed}
                  onChange={(event) => setArtifactConfirmed(event.target.checked)}
                />
                {t("research.agent.artifact_confirm")}
              </label>
              {savedArtifact && <p className="mt-3 text-12 text-success-primary">{savedArtifact}</p>}
              {artifactError && (
                <p className="mt-3 text-12 text-danger-primary" role="alert">
                  {artifactError}
                </p>
              )}
            </div>
            <div className="flex justify-end border-t border-subtle px-4 py-3">
              <button
                type="button"
                onClick={() => void saveArtifact()}
                disabled={!session || !artifactDraft.trim() || !artifactConfirmed || savingArtifact}
                className="rounded-md bg-accent-primary px-3 py-1.5 text-12 text-on-color disabled:opacity-50"
              >
                {savingArtifact ? t("research.agent.status.SAVING") : t("research.agent.save_artifact")}
              </button>
            </div>
          </div>
        </>
      )}
    </section>
  );
};
