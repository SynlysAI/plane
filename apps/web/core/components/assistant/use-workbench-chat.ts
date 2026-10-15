/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useRef, useState } from "react";
// services
import { ResearchAgentService } from "@/services/research/agent.service";
import type { TAgentRunEvent } from "@/services/research/agent.service";
// utils
import { mergeAgentMessages, type TAgentMessageItem } from "@/components/research/agent/research-agent-utils";

const agentService = new ResearchAgentService();
const POLL_INTERVAL_MS = 1500;

/**
 * Local-agent (ScienceDiscovery workbench) chat mode for the unified panel:
 * one session per chain node, messages via the workbench BFF, incremental
 * events merged with the workbench message merger. Approval/artifact cards
 * stay in the full workbench page; the panel shows a notice for them.
 */
export const useWorkbenchChat = (workspaceSlug: string, chainNodeId: string | null) => {
  const [items, setItems] = useState<TAgentMessageItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalPending, setApprovalPending] = useState(false);
  const [hasApprovalItems, setHasApprovalItems] = useState(false);
  const sessionIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  const eventsRef = useRef<TAgentRunEvent[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const refresh = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId) return;
    try {
      const response = await agentService.getEvents(workspaceSlug, runId, lastSeqRef.current);
      const events = (response?.results ?? []) as TAgentRunEvent[];
      if (events.length > 0) {
        eventsRef.current = [...eventsRef.current, ...events];
        lastSeqRef.current = events[events.length - 1].seq ?? lastSeqRef.current;
        // the workbench BFF stores only a content hash for user messages, so
        // event-derived user items render as "#seq" placeholders — the panel
        // shows its own optimistic bubble instead. Pure process lines are
        // runtime noise for a chat surface.
        setItems(
          mergeAgentMessages(eventsRef.current).filter((item) => item.kind !== "user" && item.kind !== "process")
        );
        setHasApprovalItems(eventsRef.current.some((event) => event.event_type === "APPROVAL"));
      }
      const session = (response as { session?: { status?: string } })?.session;
      const ACTIVE_STATUSES = ["STREAMING", "INITIALIZING", "QUEUED", "PENDING"];
      const status = String(session?.status ?? "");
      if (status === "WAITING_APPROVAL") setApprovalPending(true);
      if (status && !ACTIVE_STATUSES.includes(status)) {
        // run converged (READY after completion / DEGRADED / CLOSED / …)
        stopPolling();
        setBusy(false);
      }
    } catch {
      stopPolling();
      setBusy(false);
    }
  }, [stopPolling, workspaceSlug]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const send = useCallback(
    async (rawQuery: string) => {
      const query = rawQuery.trim();
      if (!query || busy || !chainNodeId) return;
      setError(null);
      setItems((previous) => [
        ...previous,
        { kind: "user", key: `user-${Date.now()}`, text: query, seq: 1e9 + Date.now() },
      ]);
      setBusy(true);
      try {
        if (!sessionIdRef.current) {
          const session = await agentService.createSession(workspaceSlug, chainNodeId);
          sessionIdRef.current = session.session_id;
          runIdRef.current = session.run_id;
        }
        const response = await agentService.sendMessage(workspaceSlug, sessionIdRef.current, query);
        if (response?.session?.run_id) runIdRef.current = response.session.run_id;
        stopPolling();
        pollRef.current = setInterval(() => void refresh(), POLL_INTERVAL_MS);
        await refresh();
      } catch (failure) {
        setBusy(false);
        setError((failure as { message?: string })?.message ?? "workbench_request_failed");
      }
    },
    [busy, chainNodeId, refresh, stopPolling, workspaceSlug]
  );

  const stop = useCallback(async () => {
    stopPolling();
    setBusy(false);
    const runId = runIdRef.current;
    if (runId) void agentService.cancelRun(workspaceSlug, runId).catch(() => undefined);
  }, [stopPolling, workspaceSlug]);

  const reset = useCallback(() => {
    stopPolling();
    sessionIdRef.current = null;
    runIdRef.current = null;
    lastSeqRef.current = 0;
    eventsRef.current = [];
    setItems([]);
    setBusy(false);
    setError(null);
    setApprovalPending(false);
    setHasApprovalItems(false);
  }, [stopPolling]);

  return {
    items,
    busy,
    error,
    approvalPending,
    hasApprovalItems,
    send,
    stop,
    reset,
  };
};
