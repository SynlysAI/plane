/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TResearchAgentSession } from "@plane/types";
// services
import { ResearchAgentService, type TAgentRunEvent } from "@/services/research/agent.service";

const agentService = new ResearchAgentService();

type Props = {
  workspaceSlug: string;
  chainNodeId: string;
};

type TPluginState = "loading_context" | "ready" | "streaming" | "degraded" | "forbidden" | "error" | "closed";

/** Merge Agent events by the stable `(run_id, seq)` cursor. */
function mergeEvents(current: TAgentRunEvent[], incoming: TAgentRunEvent[]) {
  const merged = new Map(current.map((event) => [`${event.run_id}:${event.seq}`, event]));
  for (const event of incoming) merged.set(`${event.run_id}:${event.seq}`, event);
  return [...merged.values()].reduce<TAgentRunEvent[]>((ordered, event) => {
    let index = ordered.length;
    while (index > 0 && ordered[index - 1].seq > event.seq) index -= 1;
    ordered.splice(index, 0, event);
    return ordered;
  }, []);
}

/** Same-origin Research Agent workbench with tool, artifact and trace panels. */
export const ResearchAgentPlugin = function ResearchAgentPlugin({ workspaceSlug, chainNodeId }: Props) {
  const { t } = useTranslation();
  const [session, setSession] = useState<TResearchAgentSession | null>(null);
  const [events, setEvents] = useState<TAgentRunEvent[]>([]);
  const [state, setState] = useState<TPluginState>("loading_context");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const sessionRef = useRef<TResearchAgentSession | null>(null);

  useEffect(() => {
    let active = true;
    setState("loading_context");
    setEvents([]);
    setMessage("");

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
        setState(created.status === "DEGRADED" ? "degraded" : "ready");
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

  const latestSeq = useMemo(() => events.at(-1)?.seq ?? 0, [events]);
  const toolEvents = useMemo(() => events.filter((event) => event.event_type.toUpperCase().includes("TOOL")), [events]);
  const artifactEvents = useMemo(
    () => events.filter((event) => ["DATA_CHANGE", "INTERMEDIATE_ARTIFACT", "OUTPUT"].includes(event.event_type)),
    [events]
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
      setState(session.status === "DEGRADED" ? "degraded" : "ready");
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
      setState(response.session.status === "DEGRADED" ? "degraded" : "ready");
      setMessage("");
    } catch {
      setState("error");
    } finally {
      setSending(false);
    }
  };

  const statusKey = session ? `research.agent.status.${session.status}` : undefined;

  return (
    <section className="flex h-full flex-col overflow-hidden" aria-label={t("research.agent.description")}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-subtle px-5 py-3">
        <div className="min-w-0">
          <p className="text-13 font-medium text-primary">{t("research.agent.scope")}</p>
          <p className="mt-1 truncate text-11 text-tertiary">
            {chainNodeId}
            {session && ` · ${session.context_id} · ${session.context_hash.slice(0, 12)}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md border border-subtle px-2 py-1 text-11 text-secondary">
            {statusKey ? t(statusKey) : t("research.agent.no_session")}
          </span>
          <span className="rounded-md border border-subtle px-2 py-1 text-11 text-tertiary">
            {t("research.agent.last_seq", { seq: latestSeq })}
          </span>
          <button
            type="button"
            onClick={() => void reconnect()}
            disabled={!session || reconnecting}
            className="rounded-md border border-subtle px-3 py-1.5 text-12 text-secondary hover:bg-surface-2 disabled:opacity-50"
          >
            {t("research.agent.reconnect")}
          </button>
          <button
            type="button"
            onClick={() => void stop()}
            disabled={!session || session.status === "CLOSED" || sending}
            className="rounded-md border border-danger-strong/40 px-3 py-1.5 text-12 text-danger-primary disabled:opacity-50"
          >
            {t("research.agent.stop")}
          </button>
          <button
            type="button"
            onClick={() => void close()}
            disabled={!session || session.status === "CLOSED"}
            className="rounded-md border border-subtle px-3 py-1.5 text-12 text-secondary hover:bg-surface-2 disabled:opacity-50"
          >
            {t("research.agent.close")}
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="flex min-h-0 flex-col">
          <div className="border-b border-subtle px-5 py-3">
            <p className="text-11 font-medium text-secondary">{t("research.agent.context_summary")}</p>
            <p className="mt-1 text-11 text-tertiary">{t("research.agent.context_hint")}</p>
          </div>
          <div className="flex-1 space-y-2 p-5" role="log" aria-live="polite">
            {state === "loading_context" && <p className="text-12 text-tertiary">{t("research.agent.description")}</p>}
            {state === "forbidden" && <p className="text-12 text-primary">{t("research.common.permission_denied")}</p>}
            {state === "degraded" && <p className="text-12 text-primary">{t("research.agent.degraded")}</p>}
            {!session && state !== "loading_context" && state !== "forbidden" && (
              <p className="text-12 text-tertiary">{t("research.agent.no_session")}</p>
            )}
            {events.map((event) => (
              <article
                key={`${event.run_id}:${event.seq}`}
                className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-secondary"
              >
                <p className="font-medium text-primary">
                  {event.event_type} · #{event.seq}
                </p>
                <p className="mt-1 text-11 break-all text-tertiary">{JSON.stringify(event.payload)}</p>
              </article>
            ))}
          </div>
          <form
            className="border-t border-subtle p-4"
            onSubmit={(event) => {
              event.preventDefault();
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
            <h3 className="text-12 font-medium text-primary">{t("research.agent.tools_title")}</h3>
            {toolEvents.length ? (
              <ul className="mt-2 space-y-2" role="list">
                {toolEvents.map((event) => (
                  <li key={`${event.run_id}:${event.seq}`} className="rounded-md border border-subtle p-3">
                    <p className="text-11 font-medium text-primary">{event.event_type}</p>
                    <p className="mt-1 text-11 text-tertiary">{JSON.stringify(event.payload)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-11 text-tertiary">{t("research.agent.tools_empty")}</p>
            )}
          </section>
          <section className="border-b border-subtle p-4">
            <h3 className="text-12 font-medium text-primary">{t("research.agent.artifacts_title")}</h3>
            {artifactEvents.length ? (
              <ul className="mt-2 space-y-2" role="list">
                {artifactEvents.map((event) => (
                  <li key={`${event.run_id}:${event.seq}`} className="rounded-md border border-subtle p-3">
                    <p className="text-11 font-medium text-primary">{event.event_type}</p>
                    <p className="mt-1 text-11 text-tertiary">{JSON.stringify(event.payload)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-11 text-tertiary">{t("research.agent.artifacts_empty")}</p>
            )}
          </section>
          <section className="p-4">
            <h3 className="text-12 font-medium text-primary">{t("research.agent.trace_title")}</h3>
            <ol className="mt-2 space-y-2" role="list">
              {events.map((event) => (
                <li key={`trace-${event.run_id}-${event.seq}`} className="flex gap-2 text-11 text-tertiary">
                  <span className="font-medium text-secondary">#{event.seq}</span>
                  <span>{event.event_type}</span>
                </li>
              ))}
            </ol>
          </section>
        </aside>
      </div>
    </section>
  );
};
