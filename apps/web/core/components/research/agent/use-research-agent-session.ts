"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TResearchAgentSession } from "@plane/types";
// components
import {
  agentToolStatus,
  mergeAgentEvents,
  researchAgentSessionState,
  type TResearchAgentPluginState,
} from "@/components/research/agent/research-agent-utils";
// services
import {
  ResearchAgentService,
  type TAgentApprovalDecision,
  type TAgentRunEvent,
} from "@/services/research/agent.service";

const agentService = new ResearchAgentService();

/**
 * Own the Research Agent session lifecycle: context creation, event merging,
 * messaging, reconnection, approvals and artifact saving.
 *
 * Args:
 *   workspaceSlug: Current workspace slug.
 *   chainNodeId: Chain node whose context the session inherits.
 *
 * Returns:
 *   Session state, derived collections, and stable callbacks for both layouts.
 */
export function useResearchAgentSession(workspaceSlug: string, chainNodeId: string) {
  const { t } = useTranslation();
  const [session, setSession] = useState<TResearchAgentSession | null>(null);
  const [events, setEvents] = useState<TAgentRunEvent[]>([]);
  const [state, setState] = useState<TResearchAgentPluginState>("loading_context");
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
        setEvents(mergeAgentEvents([], initial?.results ?? []));
        setState(researchAgentSessionState(created));
      } catch (error) {
        if (!active) return;
        sessionRef.current = null;
        setSession(null);
        const errorCode = (error as { error_code?: string })?.error_code;
        setState(errorCode === "AGENT_UPSTREAM_NOT_CONFIGURED" ? "degraded" : "forbidden");
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

  const latestSeq = useMemo(() => events.at(-1)?.seq ?? 0, [events]);
  const toolEvents = useMemo(() => events.filter((event) => event.event_type.toUpperCase().includes("TOOL")), [events]);
  const artifactEvents = useMemo(
    () => events.filter((event) => ["DATA_CHANGE", "INTERMEDIATE_ARTIFACT", "OUTPUT"].includes(event.event_type)),
    [events]
  );
  const approvalEvents = useMemo(
    () =>
      toolEvents.filter(
        (event) => event.payload.requires_approval === true || agentToolStatus(event.payload) === "WAITING_APPROVAL"
      ),
    [toolEvents]
  );
  const activeApproval =
    approvalFor ??
    (session?.status === "WAITING_APPROVAL" ? (approvalEvents.at(-1) ?? toolEvents.at(-1) ?? null) : null);
  const traceTypes = useMemo(() => [...new Set(events.map((event) => event.event_type))], [events]);
  const traceStatuses = useMemo(() => [...new Set(events.map((event) => agentToolStatus(event.payload)))], [events]);
  const visibleEvents = useMemo(
    () =>
      events.filter(
        (event) =>
          (!traceTypeFilter || event.event_type === traceTypeFilter) &&
          (!traceStatusFilter || agentToolStatus(event.payload) === traceStatusFilter)
      ),
    [events, traceStatusFilter, traceTypeFilter]
  );

  const close = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    try {
      const closed = await agentService.closeSession(workspaceSlug, current.session_id);
      sessionRef.current = closed;
      setSession(closed);
      setState("closed");
    } catch {
      setState("error");
    }
  }, [workspaceSlug]);

  const stop = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    try {
      const cancelled = await agentService.cancelRun(workspaceSlug, current.run_id);
      sessionRef.current = cancelled;
      setSession(cancelled);
      setState("closed");
    } catch {
      setState("error");
    }
  }, [workspaceSlug]);

  const reconnect = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || reconnecting) return;
    setReconnecting(true);
    try {
      const result = await agentService.getEvents(workspaceSlug, current.run_id, latestSeq);
      setEvents((previous) => mergeAgentEvents(previous, result.results));
      setState(researchAgentSessionState(current));
    } catch {
      setState("degraded");
    } finally {
      setReconnecting(false);
    }
  }, [latestSeq, reconnecting, workspaceSlug]);

  const send = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || !message.trim() || sending) return;
    setSending(true);
    setState("streaming");
    try {
      const response = await agentService.sendMessage(workspaceSlug, current.session_id, message.trim());
      sessionRef.current = response.session;
      setSession(response.session);
      setEvents((previous) => mergeAgentEvents(previous, response.events));
      setState(researchAgentSessionState(response.session));
      setMessage("");
    } catch {
      setState("error");
    } finally {
      setSending(false);
    }
  }, [message, sending, workspaceSlug]);

  const saveArtifact = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || !artifactDraft.trim() || !artifactConfirmed || savingArtifact) return;
    setSavingArtifact(true);
    setArtifactError("");
    try {
      const result = await agentService.saveArtifact(workspaceSlug, current.session_id, {
        artifact_type: artifactType,
        summary: artifactDraft.trim(),
        confirmed: artifactConfirmed,
        method: "AI assisted analysis",
      });
      setSavedArtifact(
        result?.snapshot_id ? `${result.snapshot_type} v${result.version}` : `DRAFT ${result?.analysis_id ?? ""}`
      );
      if (result?.event) setEvents((previous) => mergeAgentEvents(previous, [result.event]));
      setArtifactDraft("");
      setArtifactConfirmed(false);
    } catch {
      setArtifactError(t("research.agent.artifact_error"));
    } finally {
      setSavingArtifact(false);
    }
  }, [artifactConfirmed, artifactDraft, artifactType, savingArtifact, t, workspaceSlug]);

  const decideApproval = useCallback(
    async (decision: TAgentApprovalDecision) => {
      const current = sessionRef.current;
      const target = approvalFor;
      if (!current || !target || approvalBusy) return;
      setApprovalBusy(true);
      setApprovalError("");
      try {
        const key = `${target.run_id}:${target.seq}:${decision}`;
        if (!approvalRequestIdsRef.current[key]) {
          approvalRequestIdsRef.current[key] =
            globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
        }
        const result = await agentService.decideApproval(workspaceSlug, current.run_id, {
          request_id: approvalRequestIdsRef.current[key],
          decision,
          tool_call_id: String(target.payload.tool_call_id ?? target.seq),
          reason: approvalReason.trim() || undefined,
        });
        sessionRef.current = result.session;
        setSession(result.session);
        setEvents((previous) => mergeAgentEvents(previous, [result.event]));
        setState(researchAgentSessionState(result.session));
        setApprovalResult(
          decision === "APPROVED" ? t("research.agent.approval_approved") : t("research.agent.approval_rejected")
        );
      } catch {
        setApprovalError(t("research.agent.approval_error"));
      } finally {
        setApprovalBusy(false);
      }
    },
    [approvalBusy, approvalFor, approvalReason, t, workspaceSlug]
  );

  const jumpToEvent = useCallback((seq: number) => {
    setTraceTypeFilter("");
    setTraceStatusFilter("");
    queueMicrotask(() => {
      document.getElementById(`event-${seq}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }, []);

  const statusKey = session ? `research.agent.status.${session.status}` : undefined;
  const authorizedResourceCount =
    (session?.assembly.allowed_knowledge_base_ids.length ?? 0) + (session?.assembly.allowed_file_ids.length ?? 0);

  return {
    chainNodeId,
    session,
    events,
    state,
    statusKey,
    latestSeq,
    toolEvents,
    artifactEvents,
    activeApproval,
    traceTypes,
    traceStatuses,
    visibleEvents,
    authorizedResourceCount,
    message,
    setMessage,
    sending,
    reconnecting,
    artifactDrawerOpen,
    setArtifactDrawerOpen,
    artifactDraft,
    setArtifactDraft,
    artifactType,
    setArtifactType,
    artifactConfirmed,
    setArtifactConfirmed,
    savingArtifact,
    savedArtifact,
    artifactError,
    approvalFor,
    setApprovalFor,
    approvalReason,
    setApprovalReason,
    approvalBusy,
    approvalResult,
    approvalError,
    traceTypeFilter,
    setTraceTypeFilter,
    traceStatusFilter,
    setTraceStatusFilter,
    close,
    stop,
    reconnect,
    send,
    saveArtifact,
    decideApproval,
    jumpToEvent,
  };
}

/** Shared session API consumed by both the page and panel Agent layouts. */
export type TResearchAgentSessionApi = ReturnType<typeof useResearchAgentSession>;
