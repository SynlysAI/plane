"use client";

import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
// components
import {
  agentEventLabel,
  agentPayloadReferences,
  agentPayloadText,
} from "@/components/research/agent/research-agent-utils";
import type { TResearchAgentSessionApi } from "@/components/research/agent/use-research-agent-session";

type Props = {
  api: TResearchAgentSessionApi;
};

/** Conversation stream with state guidance and the fixed bottom composer. */
export function ResearchAgentConversation({ api }: Props) {
  const { t } = useTranslation();

  return (
    <>
      <div className="flex-1 space-y-2 p-4" role="log" aria-live="polite">
        {api.state === "loading_context" && <p className="text-12 text-tertiary">{t("research.agent.description")}</p>}
        {api.state === "forbidden" && <p className="text-12 text-primary">{t("research.common.permission_denied")}</p>}
        {api.state === "degraded" && <p className="text-12 text-primary">{t("research.agent.degraded")}</p>}
        {!api.session && api.state !== "loading_context" && api.state !== "forbidden" && (
          <p className="text-12 text-tertiary">{t("research.agent.no_session")}</p>
        )}
        {api.events.map((event) => {
          const narrative = agentPayloadText(event.payload, ["reasoning", "summary", "content", "message", "text"]);
          const sources = agentPayloadReferences(event.payload, ["sources", "references", "refs", "citations"]);
          return (
            <article
              key={`${event.run_id}:${event.seq}`}
              id={`event-${event.seq}`}
              className="relative border-l-2 border-subtle py-2 pl-4 text-12 text-secondary transition-colors hover:border-strong"
            >
              <p className="font-medium text-primary">
                {agentEventLabel(event.event_type, t)} · #{event.seq}
              </p>
              {narrative && <p className="mt-1 text-11 text-secondary">{narrative}</p>}
              {sources.length > 0 && (
                <ul className="mt-1 space-y-0.5 text-11 text-tertiary" role="list">
                  {sources.map((source) => (
                    <li key={source}>{source}</li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>

      <form
        className="shrink-0 border-t border-subtle p-4"
        onSubmit={(formEvent) => {
          formEvent.preventDefault();
          void api.send();
        }}
      >
        <label htmlFor="research-agent-message" className="text-11 font-medium text-secondary">
          {t("research.agent.input_label")}
        </label>
        <textarea
          id="research-agent-message"
          value={api.message}
          onChange={(event) => api.setMessage(event.target.value)}
          placeholder={t("research.agent.input_placeholder")}
          rows={3}
          className="focus:border-accent-primary mt-2 w-full resize-none rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary outline-none"
          disabled={!api.session || api.session.status === "CLOSED" || api.sending}
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          className="mt-2"
          disabled={!api.session || api.session.status === "CLOSED" || api.sending || !api.message.trim()}
        >
          {api.sending ? t("research.agent.status.STREAMING") : t("research.agent.send")}
        </Button>
      </form>
    </>
  );
}
