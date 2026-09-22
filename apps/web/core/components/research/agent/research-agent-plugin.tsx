/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useRef, useState } from "react";
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

type TPluginState = "loading_context" | "ready" | "degraded" | "forbidden" | "error" | "closed";

export const ResearchAgentPlugin = function ResearchAgentPlugin({ workspaceSlug, chainNodeId }: Props) {
  const { t } = useTranslation();
  const [session, setSession] = useState<TResearchAgentSession | null>(null);
  const [events, setEvents] = useState<TAgentRunEvent[]>([]);
  const [state, setState] = useState<TPluginState>("loading_context");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const sessionRef = useRef<TResearchAgentSession | null>(null);

  useEffect(() => {
    let active = true;
    setState("loading_context");
    setEvents([]);
    setMessage("");

    const closeQuietly = async (value: TResearchAgentSession | null) => {
      if (!value || value.status === "CLOSED") return;
      try {
        await agentService.closeSession(workspaceSlug, value.session_id);
      } catch {
        // Closing is best-effort when the browser leaves or switches scope.
      }
    };

    const start = async () => {
      try {
        const created = await agentService.createSession(workspaceSlug, chainNodeId);
        if (!active) return;
        sessionRef.current = created;
        setSession(created);
        setState("ready");
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

  const send = async () => {
    if (!session || !message.trim() || sending) return;
    setSending(true);
    try {
      const response = await agentService.sendMessage(workspaceSlug, session.session_id, message.trim());
      sessionRef.current = response.session;
      setSession(response.session);
      setEvents((current) => [...current, ...response.events]);
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
        <div>
          <p className="text-13 font-medium text-primary">{t("research.agent.scope")}</p>
          <p className="mt-1 text-11 text-tertiary">{chainNodeId}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-md border border-subtle px-2 py-1 text-11 text-secondary">
            {statusKey ? t(statusKey) : t("research.agent.no_session")}
          </span>
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

      <div className="flex-1 space-y-2 overflow-y-auto p-5" role="log" aria-live="polite">
        {state === "loading_context" && <p className="text-12 text-tertiary">{t("research.agent.description")}</p>}
        {state === "forbidden" && <p className="text-12 text-primary">{t("research.common.permission_denied")}</p>}
        {state === "degraded" && <p className="text-12 text-primary">{t("research.agent.degraded")}</p>}
        {!session && state !== "loading_context" && state !== "forbidden" && (
          <p className="text-12 text-tertiary">{t("research.agent.no_session")}</p>
        )}
        {events.map((event) => (
          <p
            key={event.request_id}
            className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-secondary"
          >
            {event.event_type} · {event.seq}
          </p>
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
          {t("research.agent.send")}
        </button>
      </form>
    </section>
  );
};
