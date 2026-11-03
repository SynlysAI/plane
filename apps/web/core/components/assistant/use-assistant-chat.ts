/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import {
  AgentDockService,
  type TAgentContextEnvelope,
  type TAgentDockEvent,
  type TAgentDockSession,
} from "@/services/agent-dock";
import { useAIAssistant } from "@/hooks/store/use-ai-assistant";
import { createSSEParser } from "./lib/parse-sse";

export type TAssistantMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type TAssistantPhase =
  | "idle"
  | "connecting"
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled"
  | "disconnected"
  | "expired";

export type TAssistantStreamState = {
  phase: TAssistantPhase;
  error?: string;
  canRetry?: boolean;
};

type TUseAssistantChatOptions = { enabled?: boolean };

const ACTIVE_PHASES = new Set<TAssistantPhase>([
  "connecting",
  "running",
  "waiting_approval",
  "cancelling",
  "disconnected",
]);
const TERMINAL_EVENTS: Record<string, TAssistantPhase> = {
  "run.completed": "completed",
  "run.failed": "failed",
  "run.cancelled": "cancelled",
};
const agentDockService = new AgentDockService();
const CONTEXT_REFRESH_SKEW_MS = 30_000;

/** Determine whether a browser-held context envelope can still authorize a turn. */
function isContextFresh(context: TAgentContextEnvelope): boolean {
  if (!["linked", "refreshed"].includes(context.status)) return false;
  const expiresAt = Date.parse(context.expiry);
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + CONTEXT_REFRESH_SKEW_MS;
}

/** 规范化 SSE 事件名和历史 JSON 事件，保持一个运行时 reducer 输入。 */
function normalizeEvent(value: unknown, eventName?: string, id?: string): TAgentDockEvent | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const payload = item.payload && typeof item.payload === "object" ? (item.payload as Record<string, unknown>) : {};
  const eventType = String(item.event_type ?? eventName ?? "");
  const sourceSeq = Number(item.source_seq ?? item.seq ?? id ?? 0);
  return {
    schema_version: String(item.schema_version ?? "agent-dock-event.v1"),
    run_id: String(item.run_id ?? ""),
    seq: Number(item.seq ?? sourceSeq),
    source_seq: Number.isFinite(sourceSeq) ? sourceSeq : 0,
    event_type: eventType,
    raw_event_type: typeof item.raw_event_type === "string" ? item.raw_event_type : undefined,
    payload,
    request_id: String(item.request_id ?? ""),
    created_at: String(item.created_at ?? ""),
  };
}

/** 归一化工具和访问证据事件，供面板列表复用既有投影。 */
function runtimeEvent(event: TAgentDockEvent): TAgentDockEvent | null {
  const payload = { ...event.payload };
  if (event.event_type === "output.delta" && event.payload.final === true) return { ...event, event_type: "OUTPUT" };
  if (event.event_type.startsWith("run.")) return { ...event, event_type: "RUN_EVENT" };
  if (event.event_type === "tool.started") {
    payload.status = "RUNNING";
    return { ...event, event_type: "TOOL_CALL", payload };
  }
  if (event.event_type === "tool.completed") {
    payload.status = payload.status === "failed" ? "FAILED" : "COMPLETED";
    payload.summary = payload.result ?? payload.summary;
    return { ...event, event_type: "TOOL_CALL", payload };
  }
  if (event.event_type === "context.accessed") return { ...event, event_type: "CONTEXT_ACCESSED" };
  if (event.event_type === "approval.required" || event.event_type === "approval.resolved") {
    return { ...event, event_type: "APPROVAL" };
  }
  if (event.event_type === "context.bound") return { ...event, event_type: "CONTEXT_ASSEMBLED" };
  return null;
}

/**
 * 管理绑定到当前 Plane 目标的 Synlora 会话，并以 SSE 驱动逐轮状态。
 * 每轮独立 generation 和 run id，关闭面板只中止浏览器订阅。
 */
export const useAssistantChat = (workspaceSlug: string, { enabled = true }: TUseAssistantChatOptions = {}) => {
  const { t } = useTranslation();
  const pathname = usePathname();
  const assistantStore = useAIAssistant();
  const [messages, setMessages] = useState<TAssistantMessage[]>([]);
  const [streamState, setStreamState] = useState<TAssistantStreamState>({ phase: "idle" });
  const [streamingAnswer, setStreamingAnswer] = useState("");
  const [contextEnvelope, setContextEnvelope] = useState<TAgentContextEnvelope | null>(null);
  const [runtimeEvents, setRuntimeEvents] = useState<TAgentDockEvent[]>([]);
  const activeRunIdRef = useRef<string | null>(null);
  const streamingAnswerRef = useRef("");
  const sessionTargetKeyRef = useRef<string | null>(null);
  const latestSeqRef = useRef(-1);
  const processedSeqRef = useRef<Set<number>>(new Set());
  const generationRef = useRef(0);
  const pendingSendRef = useRef(false);
  const pendingSendGenerationRef = useRef<number | null>(null);
  const approvalPendingRef = useRef(false);
  const streamControllerRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const connectRunRef = useRef<(runId: string, generation: number) => void>(() => undefined);
  const translateRef = useRef(t);

  useEffect(() => {
    translateRef.current = t;
  }, [t]);

  const disconnectStream = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    streamControllerRef.current?.abort();
    streamControllerRef.current = null;
  }, []);

  const appendAssistantMessage = useCallback((content: string) => {
    if (!content) return;
    setMessages((previous) => {
      if (previous.at(-1)?.role === "assistant" && previous.at(-1)?.content === content) return previous;
      return [...previous, { id: `assistant-${Date.now()}`, role: "assistant", content }];
    });
  }, []);

  const applyEvent = useCallback(
    (event: TAgentDockEvent, runId: string, generation: number) => {
      if (generationRef.current !== generation || activeRunIdRef.current !== runId || event.run_id !== runId) return;
      const sourceSeq = Number(event.source_seq ?? event.seq ?? 0);
      if (sourceSeq > 0) {
        latestSeqRef.current = Math.max(latestSeqRef.current, sourceSeq);
        if (processedSeqRef.current.has(sourceSeq)) return;
        processedSeqRef.current.add(sourceSeq);
      }
      const normalizedRuntime = runtimeEvent(event);
      if (normalizedRuntime) {
        setRuntimeEvents((previous) => {
          const key = sourceSeq || event.seq;
          if (previous.some((item) => (item.source_seq ?? item.seq) === key)) return previous;
          return [...previous, normalizedRuntime];
        });
      }

      if (event.event_type === "approval.required" || event.event_type === "approval.resolved") {
        const toolCallId = String(event.payload.tool_call_id ?? "");
        if (toolCallId) {
          setRuntimeEvents((previous) =>
            previous.map((item) =>
              item.event_type === "TOOL_CALL" && String(item.payload.tool_call_id ?? "") === toolCallId
                ? {
                    ...item,
                    payload: {
                      ...item.payload,
                      status:
                        event.event_type === "approval.required"
                          ? "WAITING_APPROVAL"
                          : String(event.payload.status ?? "COMPLETED"),
                    },
                  }
                : item
            )
          );
        }
      }

      if (event.event_type === "output.delta") {
        const content = String(event.payload.content ?? event.payload.reasoning ?? "");
        if (content) {
          const next = event.payload.final === true ? content : streamingAnswerRef.current + content;
          streamingAnswerRef.current = next;
          setStreamingAnswer(next);
        }
      } else if (event.event_type === "heartbeat") {
        setStreamState((previous) => (previous.phase === "disconnected" ? { phase: "running" } : previous));
      } else if (event.event_type === "approval.required") {
        approvalPendingRef.current = true;
        setStreamState({ phase: "waiting_approval" });
      } else if (event.event_type === "approval.resolved") {
        approvalPendingRef.current = false;
        setStreamState({ phase: "running" });
      } else if (event.event_type === "tool.completed") {
        setStreamState((previous) => (previous.phase === "waiting_approval" ? { phase: "running" } : previous));
      } else if (event.event_type === "run.progress") {
        setStreamState((previous) =>
          previous.phase === "connecting" || previous.phase === "disconnected" ? { phase: "running" } : previous
        );
      } else if (event.event_type === "stream.error") {
        setStreamState({ phase: "disconnected", error: String(event.payload.code ?? "stream_error"), canRetry: true });
      }

      const terminal = TERMINAL_EVENTS[event.event_type];
      if (terminal) {
        approvalPendingRef.current = false;
        disconnectStream();
        if (terminal === "completed")
          appendAssistantMessage(String(event.payload.content ?? streamingAnswerRef.current));
        else if (terminal === "failed") {
          setStreamState({ phase: "failed", error: String(event.payload.error ?? "run_failed"), canRetry: true });
          streamingAnswerRef.current = "";
          setStreamingAnswer("");
          activeRunIdRef.current = null;
          return;
        }
        streamingAnswerRef.current = "";
        setStreamingAnswer("");
        setStreamState({ phase: terminal });
        activeRunIdRef.current = null;
      }
    },
    [appendAssistantMessage, disconnectStream]
  );

  const scheduleReconnect = useCallback((runId: string, generation: number) => {
    if (generationRef.current !== generation || activeRunIdRef.current !== runId) return;
    setStreamState({ phase: "disconnected", canRetry: true });
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    const delay = Math.min(1000 * 2 ** reconnectAttemptRef.current, 10000);
    reconnectAttemptRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => connectRunRef.current(runId, generation), delay);
  }, []);

  connectRunRef.current = (runId, generation) => {
    if (generationRef.current !== generation || activeRunIdRef.current !== runId) return;
    streamControllerRef.current?.abort();
    const controller = new AbortController();
    streamControllerRef.current = controller;
    setStreamState((previous) => ({ phase: "connecting", ...(previous.error ? { error: previous.error } : {}) }));
    void (async () => {
      try {
        const response = await agentDockService.streamEvents(
          workspaceSlug,
          runId,
          latestSeqRef.current,
          controller.signal
        );
        const reader = response.body?.getReader();
        if (!reader) throw new Error("SSE response body is unavailable");
        const decoder = new TextDecoder();
        let terminal = false;
        const parser = createSSEParser((frame) => {
          let value: unknown;
          try {
            value = JSON.parse(frame.data);
          } catch {
            return;
          }
          const event = normalizeEvent(value, frame.event, frame.id);
          if (!event) return;
          if (
            event.event_type === "run.completed" ||
            event.event_type === "run.failed" ||
            event.event_type === "run.cancelled"
          ) {
            terminal = true;
          }
          applyEvent(event, runId, generation);
        });
        setStreamState({ phase: approvalPendingRef.current ? "waiting_approval" : "running" });
        reconnectAttemptRef.current = 0;
        while (!controller.signal.aborted) {
          // SSE chunks must be consumed in arrival order.
          // eslint-disable-next-line no-await-in-loop
          const { value, done } = await reader.read();
          if (done) break;
          parser(decoder.decode(value, { stream: true }));
        }
        parser(decoder.decode());
        parser.flush();
        if (terminal || controller.signal.aborted) return;
        scheduleReconnect(runId, generation);
      } catch (error) {
        if (controller.signal.aborted || generationRef.current !== generation) return;
        const status = Number((error as { status?: number }).status ?? 0);
        if (status === 403) {
          setStreamState({ phase: "expired", error: "agent_context_expired", canRetry: false });
          activeRunIdRef.current = null;
          return;
        }
        if ([401, 404, 409, 410].includes(status)) {
          setStreamState({
            phase: "failed",
            error: status === 401 ? "authentication_required" : "run_unavailable",
            canRetry: false,
          });
          activeRunIdRef.current = null;
          return;
        }
        if ([400, 406].includes(status)) {
          setStreamState({
            phase: "failed",
            error: status === 406 ? "stream_not_acceptable" : "stream_request_invalid",
            canRetry: false,
          });
          activeRunIdRef.current = null;
          return;
        }
        scheduleReconnect(runId, generation);
      }
    })();
  };

  const resolveContext = useCallback(async () => {
    setStreamState({ phase: "connecting" });
    try {
      const envelope = await agentDockService.resolveContext(workspaceSlug, pathname ?? `/${workspaceSlug}`);
      setContextEnvelope(envelope);
      setStreamState({ phase: "idle" });
      return envelope;
    } catch {
      setContextEnvelope(null);
      setStreamState({ phase: "failed", error: "context_unavailable", canRetry: false });
      setToast({ type: TOAST_TYPE.ERROR, title: translateRef.current("aiAssistant.error_unavailable") });
      return null;
    }
  }, [pathname, workspaceSlug]);

  useEffect(() => {
    if (assistantStore.isOpen && enabled) void resolveContext();
  }, [assistantStore.isOpen, enabled, resolveContext]);

  const loadHistory = useCallback(async () => {
    const sessionId = assistantStore.threadId;
    if (!sessionId || !contextEnvelope || pendingSendRef.current) return;
    const historyGeneration = generationRef.current;
    try {
      const session = await agentDockService.getSession(workspaceSlug, sessionId);
      if (generationRef.current !== historyGeneration || pendingSendRef.current) return;
      sessionTargetKeyRef.current = session.target_key;
      if (session.target_key !== contextEnvelope.session_binding.target_key) {
        assistantStore.clearThreadId(workspaceSlug);
        activeRunIdRef.current = null;
        setMessages([]);
        setRuntimeEvents([]);
        latestSeqRef.current = -1;
        processedSeqRef.current = new Set();
        setStreamState({ phase: "idle" });
        return;
      }
      const boundContext = await agentDockService.getContext(workspaceSlug, session.context.context_id);
      if (generationRef.current !== historyGeneration || pendingSendRef.current) return;
      setContextEnvelope(boundContext);
      const runStartCursor = Number(
        session.run_start_cursor ?? (session.assembly as { run_start_cursor?: number }).run_start_cursor ?? -1
      );
      const lastConsumedCursor = activeRunIdRef.current === session.run_id ? latestSeqRef.current : runStartCursor;
      activeRunIdRef.current = session.run_id;
      latestSeqRef.current = Math.max(runStartCursor, lastConsumedCursor);
      const history = await agentDockService.getEvents(workspaceSlug, session.run_id, 0);
      if (generationRef.current !== historyGeneration || pendingSendRef.current) return;
      const isActive = session.status === "STREAMING" || session.status === "WAITING_APPROVAL";
      for (const event of history.results) {
        const remoteType = String(event.payload.remote_type ?? "");
        const toolName = String(event.payload.name ?? "")
          .toLowerCase()
          .replaceAll("/", ".");
        const isContextAccess =
          event.payload.context_access === true ||
          toolName.split(".").some((part) => ["list", "read", "context", "knowledge"].includes(part));
        const replayType =
          remoteType === "turn/end" || remoteType === "run.completed"
            ? "run.completed"
            : remoteType === "error" || remoteType === "run.failed"
              ? "run.failed"
              : remoteType === "turn/aborted" || remoteType === "run.cancelled"
                ? "run.cancelled"
                : remoteType === "assistant/message" || remoteType === "assistant.snapshot"
                  ? "output.delta"
                  : remoteType === "tool/result" && event.event_type === "HUMAN_DECISION"
                    ? "approval.resolved"
                    : isContextAccess && (event.event_type === "TOOL_CALL" || event.payload.context_access === true)
                      ? "context.accessed"
                      : event.event_type;
        const normalized = normalizeEvent(
          {
            ...event,
            source_seq: Number(event.payload.remote_seq ?? 0),
            event_type: replayType,
          },
          undefined,
          String(event.payload.remote_seq ?? event.seq)
        );
        if (normalized) {
          normalized.run_id = session.run_id;
          if (normalized.event_type === "OUTPUT") {
            normalized.event_type = "output.delta";
            normalized.payload = { ...normalized.payload, final: true };
          } else if (normalized.event_type === "TOOL_CALL") {
            normalized.event_type = normalized.payload.status === "COMPLETED" ? "tool.completed" : "tool.started";
          } else if (normalized.event_type === "APPROVAL") {
            normalized.event_type = "approval.required";
          } else if (normalized.event_type === "DATA_CHANGE") {
            normalized.event_type = "context.accessed";
          } else if (normalized.event_type === "HUMAN_DECISION") {
            normalized.event_type = "approval.resolved";
          }
          if (remoteType === "assistant/message") {
            normalized.payload = { ...normalized.payload, final: true };
          }
          if (!isActive && normalized.event_type === "output.delta") {
            appendAssistantMessage(String(normalized.payload.content ?? ""));
            continue;
          }
          applyEvent(normalized, session.run_id, historyGeneration);
        }
      }
      // Local history omits transient deltas, so it cannot advance the browser's
      // upstream cursor beyond the last position this browser actually consumed.
      latestSeqRef.current = Math.max(runStartCursor, lastConsumedCursor);
      if (isActive) {
        connectRunRef.current(session.run_id, historyGeneration);
      } else {
        activeRunIdRef.current = null;
        const hasTerminalEvent = history.results.some((event) =>
          ["turn/end", "error", "turn/aborted", "run.completed", "run.failed", "run.cancelled"].includes(
            String(event.payload.remote_type ?? event.event_type)
          )
        );
        if (!hasTerminalEvent) setStreamState({ phase: "idle" });
        if (!hasTerminalEvent && (session.status === "DEGRADED" || session.last_error)) {
          setStreamState({ phase: "failed", error: session.last_error || "run_failed", canRetry: true });
        }
      }
    } catch (error) {
      const status = Number((error as { status?: number }).status ?? 0);
      const code = String((error as { error?: string }).error ?? "");
      if (status === 404 || code === "agent_session_not_found") {
        assistantStore.clearThreadId(workspaceSlug);
        activeRunIdRef.current = null;
        setMessages([]);
        setRuntimeEvents([]);
        latestSeqRef.current = -1;
        processedSeqRef.current = new Set();
        setStreamState({ phase: "idle" });
        return;
      }
      assistantStore.clearThreadId(workspaceSlug);
      setStreamState({ phase: "failed", error: "session_unavailable", canRetry: true });
    }
  }, [appendAssistantMessage, applyEvent, assistantStore, contextEnvelope, workspaceSlug]);

  useEffect(() => {
    if (assistantStore.isOpen && enabled && assistantStore.threadId && contextEnvelope) void loadHistory();
  }, [assistantStore.isOpen, assistantStore.threadId, contextEnvelope, enabled, loadHistory]);

  const ensureSession = useCallback(
    async (context: TAgentContextEnvelope): Promise<TAgentDockSession> => {
      if (assistantStore.threadId) {
        try {
          const existing = await agentDockService.getSession(workspaceSlug, assistantStore.threadId);
          if (existing.target_key === context.session_binding.target_key && existing.context.status !== "expired") {
            sessionTargetKeyRef.current = existing.target_key;
            const boundContext = await agentDockService.getContext(workspaceSlug, existing.context.context_id);
            if (boundContext.status === "linked") setContextEnvelope(boundContext);
            return existing;
          }
        } catch {
          // A stale local session id should be replaced with a fresh grant-bound session.
        }
        assistantStore.clearThreadId(workspaceSlug);
      }
      disconnectStream();
      setMessages([]);
      setRuntimeEvents([]);
      processedSeqRef.current = new Set();
      latestSeqRef.current = -1;
      activeRunIdRef.current = null;
      const created = await agentDockService.createSession(workspaceSlug, context.context_id);
      assistantStore.setThreadId(workspaceSlug, created.session_id);
      sessionTargetKeyRef.current = created.target_key;
      return created;
    },
    [assistantStore, disconnectStream, workspaceSlug]
  );

  const send = useCallback(
    async (rawQuery: string) => {
      const query = rawQuery.trim();
      if (!enabled || !query || ACTIVE_PHASES.has(streamState.phase) || pendingSendRef.current) return;
      generationRef.current += 1;
      const generation = generationRef.current;
      pendingSendRef.current = true;
      pendingSendGenerationRef.current = generation;
      approvalPendingRef.current = false;
      disconnectStream();
      streamingAnswerRef.current = "";
      setStreamingAnswer("");
      setStreamState({ phase: "connecting" });
      try {
        let context = contextEnvelope;
        if (!context || !isContextFresh(context)) context = await resolveContext();
        if (generationRef.current !== generation) return;
        if (!context) return;
        setStreamState({ phase: "connecting" });
        const session = await ensureSession(context);
        if (generationRef.current !== generation) return;
        setMessages((previous) => [
          ...previous,
          { id: `user-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`, role: "user", content: query },
        ]);
        const updated = await agentDockService.sendMessage(workspaceSlug, session.session_id, query);
        if (generationRef.current !== generation) {
          await agentDockService.cancelRun(workspaceSlug, updated.run_id).catch(() => undefined);
          return;
        }
        activeRunIdRef.current = updated.run_id;
        latestSeqRef.current = Number(
          updated.run_start_cursor ?? (updated.assembly as { run_start_cursor?: number }).run_start_cursor ?? -1
        );
        processedSeqRef.current = new Set();
        setStreamState({ phase: "running" });
        connectRunRef.current(updated.run_id, generation);
      } catch (error) {
        const code = String(
          (error as { error?: string; code?: string }).error ?? (error as { code?: string }).code ?? "run_failed"
        );
        if (generationRef.current === generation) {
          setStreamState({
            phase: code === "agent_context_expired" ? "expired" : "failed",
            error: code,
            canRetry: true,
          });
        }
      } finally {
        if (pendingSendGenerationRef.current === generation) {
          pendingSendRef.current = false;
          pendingSendGenerationRef.current = null;
        }
      }
    },
    [contextEnvelope, disconnectStream, enabled, ensureSession, resolveContext, streamState.phase, workspaceSlug]
  );

  const stop = useCallback(async () => {
    const runId = activeRunIdRef.current;
    const generation = ++generationRef.current;
    approvalPendingRef.current = false;
    disconnectStream();
    if (!runId) {
      setStreamState({ phase: "cancelled" });
      return;
    }
    setStreamState({ phase: "cancelling" });
    try {
      await agentDockService.cancelRun(workspaceSlug, runId);
      if (generationRef.current === generation) setStreamState({ phase: "cancelled" });
    } catch {
      if (generationRef.current === generation) {
        setStreamState({ phase: "failed", error: "cancel_failed", canRetry: true });
      }
    } finally {
      activeRunIdRef.current = null;
    }
  }, [disconnectStream, workspaceSlug]);

  /** Close only the browser subscription; the Synlora run continues. */
  const disconnect = useCallback(() => {
    disconnectStream();
    if (activeRunIdRef.current) setStreamState({ phase: "disconnected", canRetry: true });
  }, [disconnectStream]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    disconnectStream();
    approvalPendingRef.current = false;
    activeRunIdRef.current = null;
    sessionTargetKeyRef.current = null;
    latestSeqRef.current = -1;
    processedSeqRef.current = new Set();
    setRuntimeEvents([]);
    setMessages([]);
    setStreamingAnswer("");
    streamingAnswerRef.current = "";
    setStreamState({ phase: "idle" });
    assistantStore.clearThreadId(workspaceSlug);
  }, [assistantStore, disconnectStream, workspaceSlug]);

  useEffect(() => {
    if (!assistantStore.isOpen || !enabled || !activeRunIdRef.current || !ACTIVE_PHASES.has(streamState.phase)) return;
    connectRunRef.current(activeRunIdRef.current, generationRef.current);
    return disconnectStream;
    // Phase changes must not run cleanup and abort the active stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantStore.isOpen, disconnectStream, enabled]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      disconnectStream();
    },
    [disconnectStream]
  );

  const contextStatus = useMemo(
    () => contextEnvelope?.status ?? (streamState.phase === "connecting" ? "loading" : "unlinked"),
    [contextEnvelope?.status, streamState.phase]
  );

  return {
    messages,
    streamingAnswer,
    streamState,
    contextEnvelope,
    contextStatus,
    runtimeEvents,
    latestEventAt: runtimeEvents.at(-1)?.created_at ?? null,
    send,
    stop,
    disconnect,
    reset,
  };
};
