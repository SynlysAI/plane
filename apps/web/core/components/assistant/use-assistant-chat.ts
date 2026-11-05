/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
import {
  AgentDockService,
  type TAgentContextEnvelope,
  type TAgentDockEvent,
  type TAgentDockProvider,
  type TAgentDockSession,
  type TAgentFocusRef,
} from "@/services/agent-dock";
import { useAIAssistant } from "@/hooks/store/use-ai-assistant";
import { addLaunchSession, getLaunchHistory } from "./lib/launch-history";
import { createSSEParser } from "./lib/parse-sse";
import { BACKEND_AVAILABILITY_CHANGED } from "./lib/backend-availability";

export type TAssistantMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sourceId?: string;
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

type TUseAssistantChatOptions = {
  enabled?: boolean;
  provider?: TAgentDockProvider;
  focusRef?: TAgentFocusRef | null;
};

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
  if (event.event_type === "tool.started" || event.event_type === "tool.output") {
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
    payload.approval_status = event.event_type === "approval.resolved" ? "resolved" : "required";
    return { ...event, event_type: "APPROVAL", payload };
  }
  if (event.event_type === "context.bound") return { ...event, event_type: "CONTEXT_ASSEMBLED" };
  if (event.event_type === "artifact.upserted") return { ...event, event_type: "INTERMEDIATE_ARTIFACT" };
  return null;
}

/**
 * 管理当前 provider 的工作区会话，并以统一 SSE 驱动逐轮状态。
 * 每轮独立 generation 和 run id，关闭面板只中止浏览器订阅。
 */
export const useAssistantChat = (
  workspaceSlug: string,
  { enabled = true, focusRef: pageFocusRef = null, provider = "SYNLORA" }: TUseAssistantChatOptions = {}
) => {
  const { t } = useTranslation();
  const pathname = usePathname();
  const router = useRouter();
  const assistantStore = useAIAssistant();
  const [messages, setMessages] = useState<TAssistantMessage[]>([]);
  const [streamState, setStreamState] = useState<TAssistantStreamState>({ phase: "idle" });
  const [streamingAnswer, setStreamingAnswer] = useState("");
  const [contextEnvelope, setContextEnvelope] = useState<TAgentContextEnvelope | null>(null);
  const [sdAvailability, setSdAvailability] = useState<{
    scope: string;
    connection: NonNullable<TAgentContextEnvelope["science_discovery"]>;
  } | null>(null);
  const [selectedText, setSelectedText] = useState("");
  const [runtimeEvents, setRuntimeEvents] = useState<TAgentDockEvent[]>([]);
  const [inlineRunId, setInlineRunId] = useState<string | null>(null);
  const [historySessions, setHistorySessions] = useState<TAgentDockSession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const activeRunIdRef = useRef<string | null>(null);
  const streamingAnswerRef = useRef("");
  const sessionTargetKeyRef = useRef<string | null>(null);
  const latestSeqRef = useRef(-1);
  const processedSeqRef = useRef<Set<string>>(new Set());
  const pendingApprovalsRef = useRef(new Map<string, Record<string, unknown>>());
  const [pendingApprovals, setPendingApprovals] = useState<Array<Record<string, unknown>>>([]);
  const [availabilityRevision, setAvailabilityRevision] = useState(0);
  const availabilityRequestRef = useRef(0);
  const contextRequestRef = useRef(0);
  const historyLoadRequestRef = useRef(0);
  const historyRequestRef = useRef(0);
  const scopeKeyRef = useRef("");
  const phaseRef = useRef(streamState.phase);
  const generationRef = useRef(0);
  const pendingSendRef = useRef(false);
  const pendingSendGenerationRef = useRef<number | null>(null);
  const approvalPendingRef = useRef(false);
  const streamControllerRef = useRef<AbortController | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const connectRunRef = useRef<(runId: string, generation: number) => void>(() => undefined);
  const translateRef = useRef(t);
  const pendingContextKeyRef = useRef<string | null>(null);
  const resolvedContextKeyRef = useRef<string | null>(null);
  const pendingHistorySessionRef = useRef<TAgentDockSession | null>(null);
  const slot = provider === "SCIENCE_DISCOVERY" ? "local" : "cloud";
  const ownerScope = `${workspaceSlug}:${assistantStore.threadOwnerKey ?? ""}`;
  const scopeKey = `${ownerScope}:${provider}`;
  const canExecute =
    enabled &&
    (provider !== "SCIENCE_DISCOVERY" || (sdAvailability?.scope === ownerScope && sdAvailability.connection.available));
  scopeKeyRef.current = scopeKey;
  phaseRef.current = streamState.phase;

  useEffect(() => {
    generationRef.current += 1;
    streamControllerRef.current?.abort();
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
    pendingSendRef.current = false;
    pendingSendGenerationRef.current = null;
    activeRunIdRef.current = null;
    approvalPendingRef.current = false;
    pendingApprovalsRef.current.clear();
    setPendingApprovals([]);
    pendingHistorySessionRef.current = null;
    historyRequestRef.current += 1;
    historyLoadRequestRef.current += 1;
    availabilityRequestRef.current += 1;
    contextRequestRef.current += 1;
    setHistorySessions([]);
    setHistoryLoading(false);
    latestSeqRef.current = -1;
    processedSeqRef.current = new Set();
    streamingAnswerRef.current = "";
    resolvedContextKeyRef.current = null;
    pendingContextKeyRef.current = null;
    setMessages([]);
    setRuntimeEvents([]);
    setInlineRunId(null);
    setStreamingAnswer("");
    setContextEnvelope(null);
    setStreamState({ phase: "idle" });
  }, [scopeKey]);

  useEffect(() => {
    if (!assistantStore.isOpen) return;
    const invalidate = (event: Event) => {
      const changedWorkspace = (event as CustomEvent<{ workspaceSlug?: string }>).detail?.workspaceSlug;
      if (changedWorkspace && changedWorkspace !== workspaceSlug) return;
      setAvailabilityRevision((revision) => revision + 1);
    };
    invalidate(new Event("open"));
    window.addEventListener("focus", invalidate);
    window.addEventListener(BACKEND_AVAILABILITY_CHANGED, invalidate);
    return () => {
      window.removeEventListener("focus", invalidate);
      window.removeEventListener(BACKEND_AVAILABILITY_CHANGED, invalidate);
    };
  }, [assistantStore.isOpen, workspaceSlug]);

  useEffect(() => {
    if (!assistantStore.isOpen || !ACTIVE_PHASES.has(phaseRef.current)) return;
    const request = ++availabilityRequestRef.current;
    const scope = scopeKey;
    let disposed = false;
    // 运行中的配置重验只更新可用性，页面上下文仍在下一轮刷新。
    void agentDockService
      .resolveContext(workspaceSlug, pathname ?? `/${workspaceSlug}`, "", undefined, provider)
      .then((envelope) => {
        if (
          !disposed &&
          request === availabilityRequestRef.current &&
          scopeKeyRef.current === scope &&
          envelope.science_discovery
        ) {
          setSdAvailability({ scope: ownerScope, connection: envelope.science_discovery });
        }
        return null;
      })
      .catch(() => {
        if (!disposed && request === availabilityRequestRef.current && scopeKeyRef.current === scope) {
          setSdAvailability({ scope: ownerScope, connection: { available: false, reason: "context_unavailable" } });
        }
      });
    return () => {
      disposed = true;
    };
    // 聚焦、设置失效和作用域变化触发重验，运行阶段变化不触发请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantStore.isOpen, availabilityRevision, scopeKey]);

  useEffect(() => {
    translateRef.current = t;
  }, [t]);

  useEffect(() => {
    if (!assistantStore.isOpen || !enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setSelectedText(String(globalThis.getSelection()?.toString() ?? "").slice(0, 4000));
      }, 300);
    };
    update();
    document.addEventListener("selectionchange", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      if (timer) clearTimeout(timer);
    };
  }, [assistantStore.isOpen, enabled]);

  const contextKey = `${scopeKey}|${pathname ?? `/${workspaceSlug}`}|${JSON.stringify(pageFocusRef ?? null)}|${selectedText}|${availabilityRevision}`;

  const refreshHistorySessions = useCallback(async () => {
    if (!assistantStore.isOpen) return;
    const ownerKey = assistantStore.threadOwnerKey;
    const requestScope = scopeKey;
    const requestSequence = ++historyRequestRef.current;
    const isCurrent = () => scopeKeyRef.current === requestScope && historyRequestRef.current === requestSequence;
    const history = getLaunchHistory(workspaceSlug, ownerKey);
    setHistoryLoading(true);
    try {
      if (!history.sessionIds.length) {
        setHistorySessions([]);
        return;
      }
      const response = await agentDockService.listSessions(workspaceSlug, {
        sessionIds: history.sessionIds,
      });
      if (isCurrent()) setHistorySessions(response.results);
    } catch {
      if (isCurrent()) setHistorySessions([]);
    } finally {
      if (isCurrent()) setHistoryLoading(false);
    }
  }, [assistantStore.isOpen, assistantStore.threadOwnerKey, scopeKey, workspaceSlug]);

  useEffect(() => {
    void refreshHistorySessions();
  }, [refreshHistorySessions]);

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

  /** 按事件标识追加用户消息，并认领同文本的本地乐观消息。 */
  const appendUserMessage = useCallback((content: string, sourceId?: string) => {
    if (!content) return;
    setMessages((previous) => {
      if (sourceId && previous.some((item) => item.sourceId === sourceId)) return previous;
      const next = [...previous];
      let optimisticIndex = -1;
      if (sourceId) {
        for (let index = next.length - 1; index >= 0; index -= 1) {
          const item = next[index];
          if (item.role === "user" && item.content === content && !item.sourceId) {
            optimisticIndex = index;
            break;
          }
        }
      }
      if (optimisticIndex >= 0) {
        next[optimisticIndex] = { ...next[optimisticIndex], sourceId };
        return next;
      }
      return [...next, { id: sourceId ?? `user-${Date.now()}`, sourceId, role: "user" as const, content }];
    });
  }, []);

  const applyEvent = useCallback(
    (event: TAgentDockEvent, runId: string, generation: number, replayOnly = false) => {
      if (
        generationRef.current !== generation ||
        (!replayOnly && (activeRunIdRef.current !== runId || event.run_id !== runId))
      )
        return;
      const sourceSeq = Number(event.source_seq ?? event.seq ?? 0);
      if (sourceSeq > 0 || replayOnly) {
        if (!replayOnly) latestSeqRef.current = Math.max(latestSeqRef.current, sourceSeq);
        const key = `${event.run_id}:${sourceSeq > 0 ? sourceSeq : `local-${event.seq}`}`;
        if (processedSeqRef.current.has(key)) return;
        processedSeqRef.current.add(key);
      }
      const normalizedRuntime = runtimeEvent(event);
      if (normalizedRuntime) {
        setRuntimeEvents((previous) => {
          const key = sourceSeq || `local-${event.seq}`;
          const eventKey = `${event.run_id}:${key}`;
          if (previous.some((item) => `${item.run_id}:${item.source_seq || `local-${item.seq}`}` === eventKey))
            return previous;
          return [...previous, normalizedRuntime];
        });
      }

      if (event.event_type === "approval.required" || event.event_type === "approval.resolved") {
        const toolCallId = String(event.payload.tool_call_id ?? "");
        if (toolCallId) {
          setRuntimeEvents((previous) =>
            previous.map((item) =>
              item.run_id === event.run_id &&
              item.event_type === "TOOL_CALL" &&
              String(item.payload.tool_call_id ?? "") === toolCallId
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

      if (replayOnly) return;

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
        const permissionId = String(event.payload.permission_request_id ?? event.payload.tool_call_id ?? "");
        if (permissionId)
          pendingApprovalsRef.current.set(permissionId, { ...event.payload, permission_request_id: permissionId });
        setPendingApprovals([...pendingApprovalsRef.current.values()]);
        approvalPendingRef.current = true;
        setStreamState({ phase: "waiting_approval" });
      } else if (event.event_type === "approval.resolved") {
        pendingApprovalsRef.current.delete(
          String(event.payload.permission_request_id ?? event.payload.tool_call_id ?? "")
        );
        setPendingApprovals([...pendingApprovalsRef.current.values()]);
        approvalPendingRef.current = pendingApprovalsRef.current.size > 0;
        setStreamState({ phase: approvalPendingRef.current ? "waiting_approval" : "running" });
      } else if (event.event_type === "tool.completed") {
        if (!approvalPendingRef.current)
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
        pendingApprovalsRef.current.clear();
        setPendingApprovals([]);
        disconnectStream();
        if (terminal === "completed")
          appendAssistantMessage(String(event.payload.content || streamingAnswerRef.current));
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
        if (controller.signal.aborted || generationRef.current !== generation || activeRunIdRef.current !== runId) {
          void response.body?.cancel();
          return;
        }
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
          if (!event || event.run_id !== runId) return;
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

  const resolveContext = useCallback(
    async (nextFocusRef?: TAgentFocusRef) => {
      const generation = generationRef.current;
      const request = ++contextRequestRef.current;
      const availabilityRequest = ++availabilityRequestRef.current;
      setStreamState({ phase: "connecting" });
      try {
        const envelope = await agentDockService.resolveContext(
          workspaceSlug,
          pathname ?? `/${workspaceSlug}`,
          selectedText,
          nextFocusRef,
          provider
        );
        if (generation !== generationRef.current || request !== contextRequestRef.current) return null;
        setContextEnvelope(envelope);
        if (envelope.science_discovery && availabilityRequest === availabilityRequestRef.current) {
          setSdAvailability({ scope: ownerScope, connection: envelope.science_discovery });
        }
        setStreamState({ phase: "idle" });
        return envelope;
      } catch {
        if (generation !== generationRef.current || request !== contextRequestRef.current) return null;
        setContextEnvelope(null);
        setStreamState({ phase: "failed", error: "context_unavailable", canRetry: false });
        setToast({ type: TOAST_TYPE.ERROR, title: translateRef.current("aiAssistant.error_unavailable") });
        return null;
      }
    },
    [ownerScope, pathname, provider, selectedText, workspaceSlug]
  );

  useEffect(() => {
    if (!assistantStore.isOpen) return;
    if (ACTIVE_PHASES.has(streamState.phase) || pendingSendRef.current) {
      if (contextKey !== resolvedContextKeyRef.current) pendingContextKeyRef.current = contextKey;
      return;
    }
    if (
      !contextEnvelope ||
      pendingContextKeyRef.current === contextKey ||
      contextKey !== resolvedContextKeyRef.current
    ) {
      void resolveContext(pageFocusRef ?? undefined).then((envelope) => {
        if (envelope) {
          resolvedContextKeyRef.current = contextKey;
          pendingContextKeyRef.current = null;
        }
        return null;
      });
    }
  }, [
    assistantStore.isOpen,
    contextEnvelope,
    contextKey,
    enabled,
    pageFocusRef,
    pendingSendRef,
    resolveContext,
    streamState.phase,
  ]);

  const loadHistory = useCallback(async () => {
    const sessionId = assistantStore.threadId;
    if (!sessionId || pendingSendRef.current) return;
    const historyGeneration = generationRef.current;
    const request = ++historyLoadRequestRef.current;
    const scope = scopeKey;
    const isCurrent = () =>
      generationRef.current === historyGeneration &&
      historyLoadRequestRef.current === request &&
      scopeKeyRef.current === scope &&
      assistantStore.threadId === sessionId &&
      !pendingSendRef.current;
    try {
      const session = await agentDockService.getSession(workspaceSlug, sessionId);
      if (!isCurrent()) return;
      sessionTargetKeyRef.current = session.target_key;
      if (
        session.provider !== provider ||
        (contextEnvelope && session.target_key !== contextEnvelope.session_binding.target_key)
      ) {
        assistantStore.clearThreadId(workspaceSlug, slot);
        activeRunIdRef.current = null;
        setMessages([]);
        setRuntimeEvents([]);
        setInlineRunId(null);
        latestSeqRef.current = -1;
        processedSeqRef.current = new Set();
        setStreamState({ phase: "idle" });
        return;
      }
      // Keep the route-fresh envelope: replacing it with the session's original
      // context would erase the just-resolved page snapshot on every navigation.
      const history = await agentDockService.getSessionEvents(workspaceSlug, sessionId);
      const historyEvents = [...history.results];
      let cursor = history.next_cursor;
      while (cursor) {
        if (!isCurrent()) return;
        // 下一页依赖服务端返回的签名游标。
        // eslint-disable-next-line no-await-in-loop
        const page = await agentDockService.getSessionEvents(workspaceSlug, sessionId, cursor);
        historyEvents.push(...page.results);
        cursor = page.next_cursor;
      }
      if (!isCurrent()) return;
      const latestSession = history.session ?? session;
      const runStartCursor = Number(
        latestSession.run_start_cursor ??
          (latestSession.assembly as { run_start_cursor?: number }).run_start_cursor ??
          -1
      );
      disconnectStream();
      activeRunIdRef.current = latestSession.run_id;
      setInlineRunId(latestSession.run_id);
      latestSeqRef.current = runStartCursor;
      const isActive = ["INITIALIZING", "STREAMING", "WAITING_APPROVAL"].includes(latestSession.status);
      setMessages([]);
      setRuntimeEvents([]);
      processedSeqRef.current = new Set();
      pendingApprovalsRef.current.clear();
      setPendingApprovals([]);
      approvalPendingRef.current = false;
      streamingAnswerRef.current = "";
      setStreamingAnswer("");
      let replayAnswer = "";
      let replayRun = "";
      const seenHistory = new Set<string>();
      for (const event of historyEvents) {
        const eventKey = `${event.run_id}:${event.source_seq || event.payload.remote_seq || `local-${event.seq}`}`;
        if (seenHistory.has(eventKey)) continue;
        seenHistory.add(eventKey);
        if (replayRun && replayRun !== event.run_id && replayAnswer) {
          appendAssistantMessage(replayAnswer);
          replayAnswer = "";
        }
        replayRun = event.run_id;
        const isCurrentRun = event.run_id === latestSession.run_id;
        const remoteType = String(event.payload.remote_type ?? "");
        const toolName = String(event.payload.name ?? "")
          .toLowerCase()
          .replaceAll("/", ".");
        const isContextAccess =
          event.payload.context_access === true ||
          toolName.split(".").some((part) => ["list", "read", "context", "knowledge"].includes(part));
        const replayType =
          remoteType === "user/message" || event.event_type === "user.message" || event.event_type === "USER_MESSAGE"
            ? "user.message"
            : remoteType === "turn/end" || remoteType === "run.completed"
              ? "run.completed"
              : remoteType === "error" || remoteType === "run.failed"
                ? "run.failed"
                : remoteType === "turn/aborted" || remoteType === "run.cancelled"
                  ? "run.cancelled"
                  : remoteType === "assistant/message" ||
                      remoteType === "assistant.snapshot" ||
                      remoteType === "assistant.delta"
                    ? "output.delta"
                    : remoteType === "tool/result" && event.event_type === "HUMAN_DECISION"
                      ? "approval.resolved"
                      : remoteType === "permission.required"
                        ? "approval.required"
                        : remoteType === "permission.resolved"
                          ? "approval.resolved"
                          : remoteType === "artifact.upserted"
                            ? "artifact.upserted"
                            : isContextAccess &&
                                (event.event_type === "TOOL_CALL" || event.payload.context_access === true)
                              ? "context.accessed"
                              : event.event_type;
        const normalized = normalizeEvent(
          {
            ...event,
            source_seq: Number(event.payload.remote_seq ?? 0),
            event_type: event.normalized_event_type ?? replayType,
          },
          undefined,
          String(event.payload.remote_seq ?? event.seq)
        );
        if (normalized) {
          if (!event.normalized_event_type && remoteType.startsWith("tool.")) {
            const trace = (normalized.payload.trace ?? {}) as Record<string, unknown>;
            normalized.payload = {
              ...normalized.payload,
              tool_call_id: trace.id ?? normalized.payload.toolCallId,
              name: trace.name,
              arguments: trace.args ?? trace.input,
              result: trace.summary ?? trace.output ?? normalized.payload.chunk,
              status: trace.status,
            };
            normalized.event_type = remoteType;
          }
          if (!event.normalized_event_type && remoteType.startsWith("permission.")) {
            const permission = (normalized.payload.request ?? {}) as Record<string, unknown>;
            normalized.payload = {
              ...normalized.payload,
              permission_request_id: permission.id ?? normalized.payload.requestId,
              tool_call_id: permission.toolCallId ?? normalized.payload.tool_call_id,
              summary: permission.summary ?? normalized.payload.summary,
              tool: permission.action,
              resource: permission.resource,
              args_preview: permission.resource,
            };
          }
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
          if (remoteType === "assistant.snapshot") normalized.payload = { ...normalized.payload, final: true };
          if (normalized.event_type === "user.message") {
            const sourceSeq = normalized.source_seq || normalized.seq;
            appendUserMessage(
              String(normalized.payload.content ?? normalized.payload.text ?? ""),
              `${normalized.run_id}:${sourceSeq}`
            );
            continue;
          }
          if ((!isActive || !isCurrentRun) && normalized.event_type === "output.delta") {
            if (provider === "SCIENCE_DISCOVERY") {
              replayAnswer =
                normalized.payload.final === true
                  ? String(normalized.payload.content ?? "")
                  : replayAnswer + String(normalized.payload.content ?? "");
              continue;
            }
            appendAssistantMessage(String(normalized.payload.content ?? ""));
            continue;
          }
          if (provider === "SCIENCE_DISCOVERY" && normalized.event_type === "run.completed" && replayAnswer) {
            normalized.payload = { ...normalized.payload, content: normalized.payload.content || replayAnswer };
            replayAnswer = "";
          }
          if (!isCurrentRun) {
            if (normalized.event_type === "run.completed" && provider === "SCIENCE_DISCOVERY") {
              appendAssistantMessage(String(normalized.payload.content ?? ""));
            }
            applyEvent(normalized, event.run_id, historyGeneration, true);
          } else {
            applyEvent(normalized, latestSession.run_id, historyGeneration);
          }
        }
      }
      // Local history omits transient deltas, so it cannot advance the browser's
      // upstream cursor beyond the last position this browser actually consumed.
      if (replayAnswer) appendAssistantMessage(replayAnswer);
      latestSeqRef.current =
        provider === "SCIENCE_DISCOVERY"
          ? historyEvents
              .filter((event) => event.run_id === latestSession.run_id)
              .reduce((max, event) => Math.max(max, Number(event.payload.remote_seq ?? 0)), runStartCursor)
          : runStartCursor;
      if (isActive && canExecute) {
        connectRunRef.current(latestSession.run_id, historyGeneration);
      } else {
        activeRunIdRef.current = null;
        const hasTerminalEvent = historyEvents.some(
          (event) =>
            event.run_id === latestSession.run_id &&
            ["turn/end", "error", "turn/aborted", "run.completed", "run.failed", "run.cancelled"].includes(
              String(event.payload.remote_type ?? event.event_type)
            )
        );
        if (!hasTerminalEvent) setStreamState({ phase: "idle" });
        if (!hasTerminalEvent && (latestSession.status === "DEGRADED" || latestSession.last_error)) {
          setStreamState({ phase: "failed", error: latestSession.last_error || "run_failed", canRetry: true });
        }
      }
    } catch (error) {
      if (!isCurrent()) return;
      const status = Number((error as { status?: number }).status ?? 0);
      const code = String((error as { error?: string }).error ?? "");
      if (status === 404 || code === "agent_session_not_found") {
        assistantStore.clearThreadId(workspaceSlug, slot);
        activeRunIdRef.current = null;
        setMessages([]);
        setRuntimeEvents([]);
        setInlineRunId(null);
        latestSeqRef.current = -1;
        processedSeqRef.current = new Set();
        setStreamState({ phase: "idle" });
        return;
      }
      setStreamState({ phase: "failed", error: "session_unavailable", canRetry: true });
    }
  }, [
    appendAssistantMessage,
    appendUserMessage,
    applyEvent,
    assistantStore,
    contextEnvelope,
    disconnectStream,
    canExecute,
    provider,
    slot,
    scopeKey,
    workspaceSlug,
  ]);

  useEffect(() => {
    if (assistantStore.isOpen && assistantStore.threadId) void loadHistory();
  }, [assistantStore.isOpen, assistantStore.threadId, loadHistory]);

  const resetForHistorySession = useCallback(
    (sessionId: string, nextProvider: TAgentDockProvider = provider) => {
      generationRef.current += 1;
      disconnectStream();
      approvalPendingRef.current = false;
      pendingApprovalsRef.current.clear();
      setPendingApprovals([]);
      activeRunIdRef.current = null;
      sessionTargetKeyRef.current = null;
      latestSeqRef.current = -1;
      processedSeqRef.current = new Set();
      setRuntimeEvents([]);
      setInlineRunId(null);
      setMessages([]);
      setStreamingAnswer("");
      streamingAnswerRef.current = "";
      setStreamState({ phase: "idle" });
      const nextSlot = nextProvider === "SCIENCE_DISCOVERY" ? "local" : "cloud";
      assistantStore.setProvider(nextSlot);
      assistantStore.setThreadId(workspaceSlug, sessionId, nextSlot);
    },
    [assistantStore, disconnectStream, provider, workspaceSlug]
  );

  useEffect(() => {
    const pendingSession = pendingHistorySessionRef.current;
    if (!assistantStore.isOpen || !pendingSession || !contextEnvelope) return;
    if (pendingSession.target_key === contextEnvelope.session_binding.target_key) {
      pendingHistorySessionRef.current = null;
      resetForHistorySession(pendingSession.session_id, pendingSession.provider);
      return;
    }
    const targetRoute = pendingSession.target_metadata?.page?.route || "";
    const currentRoute = pathname ?? `/${workspaceSlug}`;
    if (!targetRoute || targetRoute.split("?")[0] === currentRoute.split("?")[0]) {
      pendingHistorySessionRef.current = null;
      setStreamState({
        phase: "failed",
        error: "launch_history_target_unavailable",
        canRetry: false,
      });
      setToast({
        type: TOAST_TYPE.ERROR,
        title: translateRef.current("aiAssistant.launch_history_target_unavailable"),
      });
    }
  }, [assistantStore.isOpen, contextEnvelope, enabled, pathname, resetForHistorySession, workspaceSlug]);

  const ensureSession = useCallback(
    async (context: TAgentContextEnvelope): Promise<TAgentDockSession> => {
      const generation = generationRef.current;
      const ownerKey = assistantStore.threadOwnerKey;
      if (assistantStore.threadId) {
        try {
          const existing = await agentDockService.getSession(workspaceSlug, assistantStore.threadId);
          if (generationRef.current !== generation) throw new Error("stale_session_request");
          if (existing.provider === provider && existing.target_key === context.session_binding.target_key) {
            sessionTargetKeyRef.current = existing.target_key;
            if (existing.context.status !== "expired") return existing;
            const refreshed = await agentDockService.refreshSessionContext(
              workspaceSlug,
              existing.session_id,
              context.context_id
            );
            return refreshed;
          }
        } catch {
          // A stale local session id should be replaced with a fresh grant-bound session.
        }
        if (generationRef.current !== generation) throw new Error("stale_session_request");
        assistantStore.clearThreadId(workspaceSlug, slot);
        setMessages([]);
      }
      disconnectStream();
      if (assistantStore.threadId) setMessages([]);
      setRuntimeEvents([]);
      setInlineRunId(null);
      processedSeqRef.current = new Set();
      latestSeqRef.current = -1;
      activeRunIdRef.current = null;
      const created = await agentDockService.createSession(workspaceSlug, context.context_id, provider);
      if (generationRef.current !== generation) throw new Error("stale_session_request");
      assistantStore.setThreadId(workspaceSlug, created.session_id, slot);
      addLaunchSession(workspaceSlug, ownerKey, created.session_id);
      void refreshHistorySessions();
      sessionTargetKeyRef.current = created.target_key;
      return created;
    },
    [assistantStore, disconnectStream, provider, refreshHistorySessions, slot, workspaceSlug]
  );

  const send = useCallback(
    async (rawQuery: string, messageFocusRef?: TAgentFocusRef) => {
      const query = rawQuery.trim();
      if (!canExecute || !query || ACTIVE_PHASES.has(streamState.phase) || pendingSendRef.current) return;
      generationRef.current += 1;
      const generation = generationRef.current;
      const optimisticUserId = `user-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
      pendingSendRef.current = true;
      pendingSendGenerationRef.current = generation;
      approvalPendingRef.current = false;
      pendingApprovalsRef.current.clear();
      setPendingApprovals([]);
      disconnectStream();
      streamingAnswerRef.current = "";
      setStreamingAnswer("");
      setInlineRunId(null);
      setStreamState({ phase: "connecting" });
      setMessages((previous) => [...previous, { id: optimisticUserId, role: "user", content: query }]);
      try {
        let context = contextEnvelope;
        if (!context || !isContextFresh(context)) context = await resolveContext(messageFocusRef);
        if (generationRef.current !== generation) return;
        if (!context) return;
        setStreamState({ phase: "connecting" });
        const session = await ensureSession(context);
        if (generationRef.current !== generation) return;
        setMessages((previous) =>
          previous.some((message) => message.id === optimisticUserId)
            ? previous
            : [...previous, { id: optimisticUserId, role: "user", content: query }]
        );
        const updated = await agentDockService.sendMessage(workspaceSlug, session.session_id, query, {
          route: pathname ?? `/${workspaceSlug}`,
          focusRef: messageFocusRef,
          selectedText,
          provider,
        });
        if (generationRef.current !== generation) {
          return;
        }
        activeRunIdRef.current = updated.run_id;
        setInlineRunId(updated.run_id);
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
    [
      contextEnvelope,
      disconnectStream,
      canExecute,
      ensureSession,
      pathname,
      provider,
      resolveContext,
      selectedText,
      streamState.phase,
      workspaceSlug,
    ]
  );

  const stop = useCallback(async () => {
    if (!canExecute) return;
    const runId = activeRunIdRef.current;
    const generation = ++generationRef.current;
    approvalPendingRef.current = false;
    pendingApprovalsRef.current.clear();
    setPendingApprovals([]);
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
      if (generationRef.current === generation && activeRunIdRef.current === runId) activeRunIdRef.current = null;
    }
  }, [canExecute, disconnectStream, workspaceSlug]);

  const answerApproval = useCallback(
    async (approved: boolean, permissionRequestId?: string) => {
      const runId = activeRunIdRef.current;
      if (!runId || !canExecute) return;
      const generation = generationRef.current;
      try {
        await agentDockService.answerRun(workspaceSlug, runId, approved, permissionRequestId);
        if (generationRef.current !== generation || activeRunIdRef.current !== runId) return;
        if (permissionRequestId) pendingApprovalsRef.current.delete(permissionRequestId);
        setPendingApprovals([...pendingApprovalsRef.current.values()]);
        approvalPendingRef.current = pendingApprovalsRef.current.size > 0;
        setStreamState({ phase: approvalPendingRef.current ? "waiting_approval" : "running" });
      } catch {
        if (generationRef.current !== generation || activeRunIdRef.current !== runId) return;
        setStreamState((previous) =>
          previous.phase === "waiting_approval"
            ? { ...previous, error: "approval_answer_failed", canRetry: true }
            : previous
        );
      }
    },
    [canExecute, workspaceSlug]
  );

  /** Close only the browser subscription; the Synlora run continues. */
  const disconnect = useCallback(() => {
    disconnectStream();
    if (activeRunIdRef.current) setStreamState({ phase: "disconnected", canRetry: true });
  }, [disconnectStream]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    disconnectStream();
    approvalPendingRef.current = false;
    pendingApprovalsRef.current.clear();
    setPendingApprovals([]);
    activeRunIdRef.current = null;
    sessionTargetKeyRef.current = null;
    latestSeqRef.current = -1;
    processedSeqRef.current = new Set();
    setRuntimeEvents([]);
    setInlineRunId(null);
    setMessages([]);
    setStreamingAnswer("");
    streamingAnswerRef.current = "";
    setStreamState({ phase: "idle" });
    assistantStore.clearThreadId(workspaceSlug, slot);
  }, [assistantStore, disconnectStream, slot, workspaceSlug]);

  /** Switch to one session from this browser launch batch. */
  const selectHistorySession = useCallback(
    (session: TAgentDockSession) => {
      if (ACTIVE_PHASES.has(streamState.phase) || pendingSendRef.current) return;
      if (session.target_type === "WORKSPACE" || session.target_key === contextEnvelope?.session_binding.target_key) {
        resetForHistorySession(session.session_id, session.provider);
        return true;
      }
      const route = session.target_metadata?.page?.route;
      if (!route) {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: translateRef.current("aiAssistant.launch_history_target_unavailable"),
        });
        return false;
      }
      pendingHistorySessionRef.current = session;
      router.push(route);
      return true;
    },
    [contextEnvelope, resetForHistorySession, router, streamState.phase]
  );

  useEffect(() => {
    if (!assistantStore.isOpen || !canExecute || !activeRunIdRef.current || !ACTIVE_PHASES.has(streamState.phase))
      return;
    connectRunRef.current(activeRunIdRef.current, generationRef.current);
    return disconnectStream;
    // Phase changes must not run cleanup and abort the active stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantStore.isOpen, canExecute, disconnectStream]);

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
    scienceDiscovery: sdAvailability?.scope === ownerScope ? sdAvailability.connection : null,
    pendingApprovals,
    contextStatus,
    runtimeEvents,
    inlineRunId,
    historySessions,
    historyLoading,
    latestEventAt: runtimeEvents.at(-1)?.created_at ?? null,
    send,
    stop,
    answerApproval,
    disconnect,
    reset,
    refreshHistorySessions,
    selectHistorySession,
  };
};
