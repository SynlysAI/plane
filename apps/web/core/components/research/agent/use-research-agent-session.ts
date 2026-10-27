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

/** SD 十类产物 kind → Plane 六类快照类型的默认收敛（§15.3，可按真实样本调整）。 */
const SD_ARTIFACT_TYPE_MAP: Record<string, string> = {
  report: "ANALYSIS_SUMMARY",
  markdown: "ANALYSIS_SUMMARY",
  html: "ANALYSIS_SUMMARY",
  latex: "RESEARCH_PLAN_DRAFT",
  dataset: "EXPERIMENT_DATA",
  json: "EXPERIMENT_DATA",
  structure: "EXPERIMENT_DATA",
  figure: "EXPERIMENT_DATA",
  notebook: "EXPERIMENT_RECORD",
  other: "PROCESS_NOTE",
};

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
  // 本浏览器会话的「seq → 用户明文」回显表：服务端只落 content_hash（保密契约），明文仅在此暂存。
  const [userEcho, setUserEcho] = useState<Record<number, string>>({});
  const [state, setState] = useState<TResearchAgentPluginState>("loading_context");
  const [message, setMessage] = useState("");
  const [reports, setReports] = useState<{ report_id: string; version_no: number }[]>([]);
  const [reportError, setReportError] = useState("");
  const [sending, setSending] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadedFile, setUploadedFile] = useState<string | null>(null);
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
  const pendingArtifactSourceRef = useRef<Record<string, unknown> | null>(null);

  useEffect(() => {
    let active = true;
    setState("loading_context");
    setEvents([]);
    setUserEcho({});
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
  const pollingRunId = session?.run_id;
  const pollingStatus = session?.status;
  const toolEvents = useMemo(() => events.filter((event) => event.event_type.toUpperCase().includes("TOOL")), [events]);
  const artifactEvents = useMemo(
    () => events.filter((event) => ["DATA_CHANGE", "INTERMEDIATE_ARTIFACT", "OUTPUT"].includes(event.event_type)),
    [events]
  );
  const approvalEvents = useMemo(
    () =>
      events.filter(
        (event) =>
          (event.event_type.toUpperCase().includes("TOOL") || event.event_type === "APPROVAL") &&
          (event.payload.requires_approval === true || agentToolStatus(event.payload) === "WAITING_APPROVAL")
      ),
    [events]
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

  // SD 异步链路：STREAMING 时自动轮询增量事件；指数退避（1s 起、无新事件翻倍、30s 封顶）。
  // Synlora 同步链路天然不受影响——其响应已带全量事件，session 不会停在 STREAMING。
  const pollBusyRef = useRef(false);
  useEffect(() => {
    if (!pollingRunId || pollingStatus !== "STREAMING") return;
    let cancelled = false;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (cancelled || pollBusyRef.current) return;
      const active = sessionRef.current;
      if (!active) return;
      pollBusyRef.current = true;
      let received = 0;
      try {
        const result = await agentService.getEvents(workspaceSlug, active.run_id, latestSeq);
        if (cancelled) return;
        received = result.results.length;
        if (received > 0) setEvents((previous) => mergeAgentEvents(previous, result.results));
        if (result.session) {
          sessionRef.current = result.session;
          setSession(result.session);
          setState(researchAgentSessionState(result.session));
          if (result.session.status !== "STREAMING") return;
        }
      } catch {
        // 单次轮询失败不打断会话；退避后自动重试。
      } finally {
        pollBusyRef.current = false;
      }
      delay = received > 0 ? 1000 : Math.min(delay * 2, 30000);
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [latestSeq, pollingRunId, pollingStatus, workspaceSlug]);

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
    const text = message.trim();
    if (!current || !text || sending) return;
    setSending(true);
    setState("streaming");
    try {
      const response = await agentService.sendMessage(workspaceSlug, current.session_id, text, reports);
      setReportError("");
      sessionRef.current = response.session;
      setSession(response.session);
      setEvents((previous) => mergeAgentEvents(previous, response.events));
      const communication = response.events.find((event) => event.event_type === "COMMUNICATION");
      if (communication) setUserEcho((previous) => ({ ...previous, [communication.seq]: text }));
      setState(researchAgentSessionState(response.session));
      setMessage("");
    } catch (failure) {
      setReportError((failure as { message?: string })?.message ?? "报告或 Agent 读取失败，请重新选择正式报告后重试。");
      setState("error");
    } finally {
      setSending(false);
    }
  }, [message, sending, workspaceSlug, reports]);

  /** 上传一个分析文件到当前会话的 ScienceDiscovery 工作区（任意类型，§9）。 */
  const uploadFile = useCallback(
    async (file: File) => {
      const current = sessionRef.current;
      if (!current || uploadingFile) return;
      setUploadingFile(true);
      setUploadError("");
      setUploadedFile(null);
      try {
        const result = await agentService.uploadSessionFile(workspaceSlug, current.session_id, file);
        if (result.event) setEvents((previous) => mergeAgentEvents(previous, [result.event!]));
        setUploadedFile(result.upload?.file_name ?? file.name);
      } catch (failure) {
        setUploadError((failure as { message?: string })?.message ?? t("research.agent.file_upload_error"));
      } finally {
        setUploadingFile(false);
      }
    },
    [t, uploadingFile, workspaceSlug]
  );

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
        source_versions: pendingArtifactSourceRef.current ? [pendingArtifactSourceRef.current] : [],
        method: "AI assisted analysis",
      });
      setSavedArtifact(
        result?.snapshot_id ? `${result.snapshot_type} v${result.version}` : `DRAFT ${result?.analysis_id ?? ""}`
      );
      if (result?.event) setEvents((previous) => mergeAgentEvents(previous, [result.event]));
      setArtifactDraft("");
      setArtifactConfirmed(false);
      pendingArtifactSourceRef.current = null;
    } catch {
      setArtifactError(t("research.agent.artifact_error"));
    } finally {
      setSavingArtifact(false);
    }
  }, [artifactConfirmed, artifactDraft, artifactType, savingArtifact, t, workspaceSlug]);

  /** 从产物卡预填「保存到节点」抽屉，并携带 SD 版本引用（§8 第三层）。 */
  const prepareArtifactSave = useCallback((event: TAgentRunEvent) => {
    const artifact = (event.payload.artifact ?? {}) as { name?: string; kind?: string; description?: string };
    const version = (event.payload.version ?? {}) as {
      id?: string;
      mediaType?: string;
      content?: { hash?: string };
    };
    setArtifactType(SD_ARTIFACT_TYPE_MAP[String(artifact.kind ?? "")] ?? "ANALYSIS_SUMMARY");
    setArtifactDraft(String(artifact.description || artifact.name || "").slice(0, 2000));
    setArtifactConfirmed(false);
    setArtifactDrawerOpen(true);
    pendingArtifactSourceRef.current = version.id
      ? {
          provider: "SCIENCE_DISCOVERY",
          session_id: sessionRef.current?.session_id ?? "",
          artifact_name: artifact.name ?? "",
          artifact_kind: artifact.kind ?? "",
          version_id: version.id,
          media_type: version.mediaType ?? "",
          content_hash: version.content?.hash ?? "",
        }
      : null;
  }, []);

  /** 通过 BFF 代理下载 SD 产物内容（Plane 不存字节，§8 第二层）。 */
  const downloadArtifact = useCallback(
    async (event: TAgentRunEvent) => {
      const current = sessionRef.current;
      const version = (event.payload.version ?? {}) as { id?: string };
      const artifact = (event.payload.artifact ?? {}) as { name?: string };
      const versionId = String(version.id ?? "");
      if (!current || !versionId) return;
      setArtifactError("");
      try {
        const blob = await agentService.downloadArtifactContent(workspaceSlug, current.session_id, versionId);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = artifact.name || versionId;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch {
        setArtifactError(t("research.agent.artifact_download_error"));
      }
    },
    [t, workspaceSlug]
  );

  const decideApproval = useCallback(
    async (decision: TAgentApprovalDecision, targetEvent?: TAgentRunEvent) => {
      const current = sessionRef.current;
      const target = targetEvent ?? approvalFor;
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
          decision === "REJECTED" ? t("research.agent.approval_rejected") : t("research.agent.approval_approved")
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
    workspaceSlug,
    reports,
    setReports,
    reportError,
    chainNodeId,
    session,
    events,
    userEcho,
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
    uploadingFile,
    uploadError,
    uploadedFile,
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
    uploadFile,
    saveArtifact,
    prepareArtifactSave,
    downloadArtifact,
    decideApproval,
    jumpToEvent,
  };
}

/** Shared session API consumed by both the page and panel Agent layouts. */
export type TResearchAgentSessionApi = ReturnType<typeof useResearchAgentSession>;
