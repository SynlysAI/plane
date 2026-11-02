/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useTranslation } from "@plane/i18n";
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
// services
import {
  AgentDockService,
  type TAgentContextEnvelope,
  type TAgentDockEvent,
  type TAgentDockSession,
} from "@/services/agent-dock";
// store
import { useAIAssistant } from "@/hooks/store/use-ai-assistant";

export type TAssistantMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type TAssistantStreamState =
  | { phase: "idle" }
  | { phase: "loading-history" }
  | { phase: "loading-context" }
  | { phase: "queued" }
  | { phase: "streaming"; status: string | null }
  | { phase: "interrupted" }
  | { phase: "error"; canRetry: boolean };

const ACTIVE_STATUSES = new Set(["INITIALIZING", "READY", "QUEUED", "PENDING", "STREAMING"]);
const agentDockService = new AgentDockService();

/**
 * Own the target-bound cloud Agent conversation and its visible context.
 *
 * The browser sends only the current route. Plane resolves ACL, issues the v3
 * context, and returns a display envelope; tokens and resource bodies stay server-side.
 */
export const useAssistantChat = (workspaceSlug: string) => {
  const { t } = useTranslation();
  const pathname = usePathname();
  const assistantStore = useAIAssistant();
  const [messages, setMessages] = useState<TAssistantMessage[]>([]);
  const [streamState, setStreamState] = useState<TAssistantStreamState>({ phase: "idle" });
  const [streamingAnswer, setStreamingAnswer] = useState("");
  const [contextEnvelope, setContextEnvelope] = useState<TAgentContextEnvelope | null>(null);
  const [runtimeEvents, setRuntimeEvents] = useState<TAgentDockEvent[]>([]);
  const activeRunIdRef = useRef<string | null>(null);
  const latestSeqRef = useRef(0);
  const processedSeqRef = useRef<Set<number>>(new Set());
  const historyLoadedRef = useRef(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const translateRef = useRef(t);

  useEffect(() => {
    translateRef.current = t;
  }, [t]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = null;
  }, []);

  const appendAssistantMessage = useCallback((content: string) => {
    if (!content) return;
    setMessages((previous) => {
      if (previous.at(-1)?.role === "assistant" && previous.at(-1)?.content === content) return previous;
      return [...previous, { id: `assistant-${Date.now()}`, role: "assistant", content }];
    });
  }, []);

  const applyEvents = useCallback(
    (events: TAgentDockEvent[], session?: TAgentDockSession) => {
      let approvalPending = false;
      const newRuntimeEvents: TAgentDockEvent[] = [];
      for (const event of events) {
        if (processedSeqRef.current.has(event.seq)) continue;
        processedSeqRef.current.add(event.seq);
        latestSeqRef.current = Math.max(latestSeqRef.current, event.seq);
        if (["TOOL_CALL", "APPROVAL", "CONTEXT_ASSEMBLED", "OUTPUT"].includes(event.event_type)) {
          newRuntimeEvents.push(event);
        }
        if (event.event_type === "OUTPUT") {
          const content = String(event.payload.content ?? "");
          if (content) appendAssistantMessage(content);
        } else if (event.event_type === "TOOL_CALL") {
          const name = String(event.payload.name ?? event.payload.tool_call_id ?? "tool");
          const status = String(event.payload.status ?? "RUNNING").toLowerCase();
          setStreamState((state) => (state.phase === "streaming" ? { ...state, status: `${name}:${status}` } : state));
        } else if (event.event_type === "APPROVAL") {
          approvalPending = true;
        }
      }
      if (newRuntimeEvents.length) {
        setRuntimeEvents((previous) => {
          const merged = new Map(previous.map((item) => [item.seq, item]));
          for (const item of newRuntimeEvents) merged.set(item.seq, item);
          return [...merged.values()].toSorted((left, right) => left.seq - right.seq);
        });
      }
      if (approvalPending) {
        stopPolling();
        setStreamState({ phase: "interrupted" });
      } else if (session && !ACTIVE_STATUSES.has(session.status)) {
        stopPolling();
        setStreamState(
          session.status === "DEGRADED" || session.status === "ERROR"
            ? { phase: "error", canRetry: true }
            : { phase: "idle" }
        );
      }
    },
    [appendAssistantMessage, stopPolling]
  );

  const pollEvents = useCallback(
    async (runId: string, immediate = false) => {
      if (!immediate && pollTimerRef.current) return;
      try {
        const result = await agentDockService.getEvents(workspaceSlug, runId, latestSeqRef.current);
        applyEvents(result.results, result.session);
        if (ACTIVE_STATUSES.has(result.session.status)) {
          pollTimerRef.current = setTimeout(() => void pollEvents(runId), 1200);
        }
      } catch {
        stopPolling();
        setStreamState({ phase: "error", canRetry: true });
      }
    },
    [applyEvents, stopPolling, workspaceSlug]
  );

  const resolveContext = useCallback(async () => {
    setStreamState({ phase: "loading-context" });
    try {
      const envelope = await agentDockService.resolveContext(workspaceSlug, pathname ?? `/${workspaceSlug}`);
      setContextEnvelope(envelope);
      setStreamState({ phase: "idle" });
      return envelope;
    } catch {
      setContextEnvelope(null);
      setStreamState({ phase: "error", canRetry: false });
      setToast({ type: TOAST_TYPE.ERROR, title: translateRef.current("aiAssistant.error_unavailable") });
      return null;
    }
  }, [pathname, workspaceSlug]);

  useEffect(() => {
    if (assistantStore.isOpen) void resolveContext();
  }, [assistantStore.isOpen, resolveContext]);

  const loadHistory = useCallback(async () => {
    const sessionId = assistantStore.threadId;
    if (!sessionId || historyLoadedRef.current) return;
    historyLoadedRef.current = true;
    setStreamState({ phase: "loading-history" });
    try {
      const session = await agentDockService.getSession(workspaceSlug, sessionId);
      activeRunIdRef.current = session.run_id;
      const history = await agentDockService.getEvents(workspaceSlug, session.run_id, 0);
      applyEvents(history.results, history.session);
      if (ACTIVE_STATUSES.has(history.session.status)) void pollEvents(session.run_id, true);
      else setStreamState({ phase: "idle" });
    } catch {
      assistantStore.clearThreadId(workspaceSlug);
      setStreamState({ phase: "error", canRetry: true });
    }
  }, [applyEvents, assistantStore, pollEvents, workspaceSlug]);

  useEffect(() => {
    if (assistantStore.isOpen && assistantStore.threadId && contextEnvelope) void loadHistory();
  }, [assistantStore.isOpen, assistantStore.threadId, contextEnvelope, loadHistory]);

  const ensureSession = useCallback(
    async (context: TAgentContextEnvelope): Promise<TAgentDockSession> => {
      if (assistantStore.threadId) {
        return agentDockService.getSession(workspaceSlug, assistantStore.threadId);
      }
      const created = await agentDockService.createSession(workspaceSlug, context.context_id);
      assistantStore.setThreadId(workspaceSlug, created.session_id);
      activeRunIdRef.current = created.run_id;
      historyLoadedRef.current = true;
      return created;
    },
    [assistantStore, workspaceSlug]
  );

  const send = useCallback(
    async (rawQuery: string) => {
      const query = rawQuery.trim();
      if (!query || streamState.phase === "streaming" || streamState.phase === "queued") return;
      const context = contextEnvelope ?? (await resolveContext());
      if (!context) return;
      setMessages((previous) => [...previous, { id: `user-${Date.now()}`, role: "user", content: query }]);
      setStreamingAnswer("");
      setStreamState({ phase: "queued" });
      try {
        const session = await ensureSession(context);
        const updated = await agentDockService.sendMessage(workspaceSlug, session.session_id, query);
        activeRunIdRef.current = updated.run_id;
        setStreamState({ phase: "streaming", status: null });
        await pollEvents(updated.run_id, true);
      } catch {
        setStreamState({ phase: "error", canRetry: true });
      }
    },
    [contextEnvelope, ensureSession, pollEvents, resolveContext, streamState.phase, workspaceSlug]
  );

  const stop = useCallback(async () => {
    stopPolling();
    const runId = activeRunIdRef.current;
    if (!runId) return;
    await agentDockService.cancelRun(workspaceSlug, runId).catch(() => undefined);
    setStreamState({ phase: "idle" });
  }, [stopPolling, workspaceSlug]);

  /** Close only the browser subscription. The upstream run continues. */
  const disconnect = useCallback(() => {
    stopPolling();
  }, [stopPolling]);

  const reset = useCallback(() => {
    stopPolling();
    historyLoadedRef.current = false;
    activeRunIdRef.current = null;
    latestSeqRef.current = 0;
    processedSeqRef.current = new Set();
    setRuntimeEvents([]);
    setMessages([]);
    setStreamingAnswer("");
    setStreamState({ phase: "idle" });
    assistantStore.clearThreadId(workspaceSlug);
  }, [assistantStore, stopPolling, workspaceSlug]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const contextStatus = useMemo(
    () => contextEnvelope?.status ?? (streamState.phase === "loading-context" ? "loading" : "unlinked"),
    [contextEnvelope?.status, streamState.phase]
  );

  return {
    messages,
    streamingAnswer,
    streamState,
    contextEnvelope,
    contextStatus,
    runtimeEvents,
    send,
    stop,
    disconnect,
    reset,
  };
};
