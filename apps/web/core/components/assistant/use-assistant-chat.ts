/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "@plane/i18n";
// plane
import { setToast, TOAST_TYPE } from "@plane/propel/toast";
// components
import { createSSEParser, reduceSynloraFrame, type TSSEFrame } from "./lib/parse-sse";
// services
import { AssistantService } from "@/services/assistant";
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
  | { phase: "queued" }
  | { phase: "streaming"; status: string | null }
  | { phase: "interrupted" }
  | { phase: "error"; canRetry: boolean };

const assistantService = new AssistantService();

/**
 * One continuing conversation per workspace. Messages are view-local; only
 * the thread id persists (store + localStorage). The stream lifecycle is a
 * linear state machine: queued → streaming → idle/interrupted/error.
 */
export const useAssistantChat = (workspaceSlug: string, pageContext: string) => {
  const { t } = useTranslation();
  const assistantStore = useAIAssistant();
  const [messages, setMessages] = useState<TAssistantMessage[]>([]);
  const [streamState, setStreamState] = useState<TAssistantStreamState>({ phase: "idle" });
  const [streamingAnswer, setStreamingAnswer] = useState("");

  const abortRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const endRef = useRef(false);
  const errorRef = useRef(false);
  const interruptRef = useRef(false);
  const lastEventIdRef = useRef<string | null>(null);
  const answerRef = useRef("");
  const parserRef = useRef<((chunk: string) => void) | null>(null);
  const historyLoadedRef = useRef(false);

  const ensureThread = useCallback(async (): Promise<string> => {
    if (assistantStore.threadId) return assistantStore.threadId;
    const session = await assistantService.createSession(workspaceSlug, `Plane/${workspaceSlug}`);
    assistantStore.setThreadId(workspaceSlug, session.thread_id);
    return session.thread_id;
  }, [assistantStore, workspaceSlug]);

  const loadHistory = useCallback(async () => {
    if (historyLoadedRef.current || !assistantStore.threadId) return;
    historyLoadedRef.current = true;
    setStreamState({ phase: "loading-history" });
    try {
      const history = await assistantService.getHistory(workspaceSlug, assistantStore.threadId);
      const mapped = history
        .filter((message) => message.content)
        .map((message, index) => ({
          id: message.id ?? `history-${index}`,
          role: message.role === "user" ? ("user" as const) : ("assistant" as const),
          content: message.content ?? "",
        }));
      setMessages(mapped);
    } catch {
      // a stale thread id just starts a fresh conversation on next send
      historyLoadedRef.current = false;
    } finally {
      setStreamState({ phase: "idle" });
    }
  }, [assistantStore.threadId, workspaceSlug]);

  useEffect(() => {
    if (assistantStore.isOpen) void loadHistory();
  }, [assistantStore.isOpen, loadHistory]);

  const applyFrame = useCallback((frame: TSSEFrame) => {
    if (frame.id) lastEventIdRef.current = frame.id;
    for (const event of reduceSynloraFrame(frame)) {
      if (event.type === "answer_delta") {
        // the ref is the source of truth for post-stream reads; the state
        // drives rendering
        answerRef.current += event.content;
        setStreamingAnswer(answerRef.current);
      } else if (event.type === "status")
        setStreamState((state) => (state.phase === "streaming" ? { ...state, status: event.label } : state));
      else if (event.type === "end") endRef.current = true;
      else if (event.type === "interrupt") interruptRef.current = true;
      else if (event.type === "error") errorRef.current = true;
    }
  }, []);

  const consumeStream = useCallback(
    async (runId: string, allowReconnect: boolean): Promise<void> => {
      const controller = new AbortController();
      abortRef.current = controller;
      parserRef.current = createSSEParser(applyFrame);
      try {
        await assistantService.streamRunEvents(workspaceSlug, runId, {
          lastEventId: lastEventIdRef.current,
          signal: controller.signal,
          onChunk: (chunk) => parserRef.current?.(chunk),
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        // one automatic reconnect with Last-Event-ID; Synlora replays the
        // run's events from the cursor, so no content is lost
        if (allowReconnect && !endRef.current) {
          await consumeStream(runId, false);
          return;
        }
        throw error;
      }
    },
    [applyFrame, workspaceSlug]
  );

  const pollQueuedRun = useCallback(
    async (runId: string, attempt = 0): Promise<void> => {
      if (attempt >= 150) throw new Error("assistant_queue_timeout");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const result = await assistantService.getRunResult(workspaceSlug, runId);
      if (result.status !== "queued" && result.status !== "pending" && result.status !== "dispatched") return;
      await pollQueuedRun(runId, attempt + 1);
    },
    [workspaceSlug]
  );

  const appendAssistantMessage = useCallback((content: string) => {
    if (!content) return;
    setMessages((previous) => [...previous, { id: `assistant-${Date.now()}`, role: "assistant", content }]);
  }, []);

  const send = useCallback(
    async (rawQuery: string) => {
      const query = rawQuery.trim();
      if (!query || streamState.phase === "streaming" || streamState.phase === "queued") return;
      const previousMessages = messages;
      setMessages([...previousMessages, { id: `user-${Date.now()}`, role: "user", content: query }]);
      setStreamingAnswer("");
      answerRef.current = "";
      setStreamState({ phase: "queued" });
      endRef.current = false;
      errorRef.current = false;
      interruptRef.current = false;
      lastEventIdRef.current = null;

      let threadId: string;
      try {
        threadId = await ensureThread();
      } catch {
        setStreamState({ phase: "error", canRetry: false });
        setToast({ type: TOAST_TYPE.ERROR, title: t("aiAssistant.error_unavailable") });
        return;
      }
      const fullQuery = pageContext ? `${pageContext}\n\n${query}` : query;
      try {
        const chat = await assistantService.startChat(workspaceSlug, { query: fullQuery, thread_id: threadId });
        if (!chat.run_id) throw new Error("assistant_no_run");
        activeRunIdRef.current = chat.run_id;
        if (chat.queued) await pollQueuedRun(chat.run_id);
        setStreamState({ phase: "streaming", status: null });
        await consumeStream(chat.run_id, true);
      } catch {
        appendAssistantMessage(answerRef.current);
        setStreamingAnswer("");
        answerRef.current = "";
        setStreamState({ phase: "error", canRetry: true });
        return;
      }
      appendAssistantMessage(answerRef.current);
      setStreamingAnswer("");
      answerRef.current = "";
      if (errorRef.current) setStreamState({ phase: "error", canRetry: true });
      else if (interruptRef.current) setStreamState({ phase: "interrupted" });
      else setStreamState({ phase: "idle" });
    },
    [
      appendAssistantMessage,
      consumeStream,
      ensureThread,
      messages,
      pageContext,
      pollQueuedRun,
      streamState.phase,
      t,
      workspaceSlug,
    ]
  );

  const stop = useCallback(async () => {
    abortRef.current?.abort();
    const runId = activeRunIdRef.current;
    if (runId) {
      // an explicit stop cancels the upstream run; closing the panel does not
      void assistantService.cancelRun(workspaceSlug, runId).catch(() => undefined);
    }
  }, [workspaceSlug]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    historyLoadedRef.current = false;
    setMessages([]);
    setStreamingAnswer("");
    setStreamState({ phase: "idle" });
    assistantStore.clearThreadId(workspaceSlug);
  }, [assistantStore, workspaceSlug]);

  return {
    messages,
    streamingAnswer,
    streamState,
    send,
    stop,
    reset,
  };
};
