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
/** polls without new events before treating a blocked run as waiting */
const STALL_POLLS_LIMIT = 3;

type TSection = {
  userKey: string;
  text: string;
  /** index into the raw event log where this section's run begins */
  startEventCount: number;
  items: TAgentMessageItem[];
};

/**
 * Local-agent (ScienceDiscovery workbench) chat mode for the unified panel.
 *
 * Messages are grouped per send: each section keeps its user bubble plus the
 * merged items of its own run (merged from the raw events captured after the
 * send), so bubbles never vanish or duplicate across polls. Approvals are
 * detected from APPROVAL events (the BFF session stays STREAMING while the
 * SD run is blocked) and can be decided inline, resuming the same section.
 */
export const useWorkbenchChat = (workspaceSlug: string, chainNodeId: string | null) => {
  const [sections, setSections] = useState<TSection[]>([]);
  const [busy, setBusy] = useState(false);
  const [waitingApproval, setWaitingApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  const eventsRef = useRef<TAgentRunEvent[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stallRef = useRef(0);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const applyEvents = useCallback((events: TAgentRunEvent[]) => {
    setSections((previous) => {
      if (previous.length === 0) return previous;
      const next = [...previous];
      const current = next[next.length - 1];
      // merge only this section's events; user messages are hash-only on the
      // server, so event-derived user placeholders are dropped
      current.items = mergeAgentMessages(events.slice(current.startEventCount)).filter((item) => item.kind !== "user");
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const runId = runIdRef.current;
    if (!runId) return;
    try {
      const response = await agentService.getEvents(workspaceSlug, runId, lastSeqRef.current);
      const events = (response?.results ?? []) as TAgentRunEvent[];
      const session = (response as { session?: { status?: string } })?.session;
      if (events.length > 0) {
        stallRef.current = 0;
        eventsRef.current = [...eventsRef.current, ...events];
        lastSeqRef.current = events[events.length - 1].seq ?? lastSeqRef.current;
        applyEvents(eventsRef.current);
      } else {
        stallRef.current += 1;
      }
      const hasApproval = eventsRef.current.some((event) => event.event_type === "APPROVAL");
      const status = String(session?.status ?? "");
      const ACTIVE_STATUSES = ["STREAMING", "INITIALIZING", "QUEUED", "PENDING"];
      const stalled = stallRef.current >= STALL_POLLS_LIMIT;
      if (hasApproval && stalled) {
        // the SD run is blocked on permission — waiting, not working
        setWaitingApproval(true);
        setBusy(false);
        stopPolling();
        return;
      }
      if (status && !ACTIVE_STATUSES.includes(status)) {
        stopPolling();
        setBusy(false);
      }
    } catch {
      stopPolling();
      setBusy(false);
    }
  }, [applyEvents, stopPolling, workspaceSlug]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const resumePolling = useCallback(() => {
    stopPolling();
    stallRef.current = 0;
    setBusy(true);
    pollRef.current = setInterval(() => void refresh(), POLL_INTERVAL_MS);
  }, [refresh, stopPolling]);

  const send = useCallback(
    async (rawQuery: string) => {
      const query = rawQuery.trim();
      if (!query || busy || waitingApproval || !chainNodeId) return;
      setError(null);
      setSections((previous) => [
        ...previous,
        {
          userKey: `user-${Date.now()}`,
          text: query,
          startEventCount: eventsRef.current.length,
          items: [],
        },
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
        resumePolling();
        await refresh();
      } catch (failure) {
        setBusy(false);
        setError((failure as { message?: string })?.message ?? "workbench_request_failed");
      }
    },
    [busy, chainNodeId, refresh, resumePolling, waitingApproval, workspaceSlug]
  );

  const stop = useCallback(async () => {
    stopPolling();
    setBusy(false);
    const runId = runIdRef.current;
    if (runId) void agentService.cancelRun(workspaceSlug, runId).catch(() => undefined);
  }, [stopPolling, workspaceSlug]);

  const decide = useCallback(
    async (approved: boolean) => {
      const runId = runIdRef.current;
      if (!runId) return;
      const approvalEvent = eventsRef.current.find((event) => event.event_type === "APPROVAL");
      const toolCallId = String(
        ((approvalEvent?.payload as { request?: { id?: string } } | undefined)?.request ?? {}).id ?? ""
      );
      try {
        await agentService.decideApproval(workspaceSlug, runId, {
          request_id: `panel-${Date.now()}`,
          decision: approved ? "APPROVED" : "REJECTED",
          tool_call_id: toolCallId,
        });
        setWaitingApproval(false);
        // the run continues server-side; watch it again so the resumed
        // answer streams into the same section
        resumePolling();
      } catch (failure) {
        setError((failure as { message?: string })?.message ?? "approval_failed");
      }
    },
    [resumePolling, workspaceSlug]
  );

  const reset = useCallback(() => {
    stopPolling();
    sessionIdRef.current = null;
    runIdRef.current = null;
    lastSeqRef.current = 0;
    eventsRef.current = [];
    stallRef.current = 0;
    setSections([]);
    setBusy(false);
    setWaitingApproval(false);
    setError(null);
  }, [stopPolling]);

  return {
    sections,
    busy,
    waitingApproval,
    error,
    send,
    stop,
    reset,
    decide,
  };
};
