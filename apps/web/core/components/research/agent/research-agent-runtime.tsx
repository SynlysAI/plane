"use client";

import { useTranslation } from "@plane/i18n";
// components
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import {
  agentEventLabel,
  agentPayloadReferences,
  agentPayloadText,
  agentRiskLevel,
  agentToolStatus,
} from "@/components/research/agent/research-agent-utils";
import type { TResearchAgentSessionApi } from "@/components/research/agent/use-research-agent-session";

type Props = {
  api: TResearchAgentSessionApi;
};

/** Structured runtime detail: tool cards, artifacts and the filterable trace list. */
export function ResearchAgentRuntime({ api }: Props) {
  const { t } = useTranslation();

  return (
    <>
      <section className="border-b border-subtle p-4">
        <h3 className="text-12 font-semibold text-primary">{t("research.agent.tools_title")}</h3>
        {api.toolEvents.length ? (
          <ul className="mt-2 space-y-2" role="list">
            {api.toolEvents.map((event) => {
              const status = agentToolStatus(event.payload);
              const risk = agentRiskLevel(event.payload);
              const toolName =
                agentPayloadText(event.payload, ["tool_name", "tool", "name", "capability"]) ||
                agentEventLabel(event.event_type, t);
              const scope = agentPayloadText(event.payload, ["capability_scope", "scope", "scope_id"]);
              const input = agentPayloadText(event.payload, ["input_summary", "query", "input", "prompt"]);
              const outputs = agentPayloadReferences(event.payload, ["output_refs", "output", "references"]);
              return (
                <li
                  key={`tool-${event.run_id}-${event.seq}`}
                  id={`tool-${event.seq}`}
                  className="rounded-lg border border-subtle bg-surface-1 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-11 font-semibold text-primary">{toolName}</p>
                    <ResearchStatusBadge status={status} size="sm">
                      {t(`research.agent.tool_status.${status.toLowerCase()}`)}
                    </ResearchStatusBadge>
                  </div>
                  <dl className="mt-2 space-y-1 text-11">
                    {scope && (
                      <div className="flex gap-2">
                        <dt className="text-tertiary">{t("research.agent.tool_scope")}</dt>
                        <dd className="min-w-0 flex-1 break-words text-secondary">{scope}</dd>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <dt className="text-tertiary">{t("research.agent.tool_risk")}</dt>
                      <dd className="text-secondary">{t(`research.agent.risk.${risk.toLowerCase()}`)}</dd>
                    </div>
                    {input && (
                      <div className="flex gap-2">
                        <dt className="text-tertiary">{t("research.agent.tool_input")}</dt>
                        <dd className="min-w-0 flex-1 break-words text-secondary">{input}</dd>
                      </div>
                    )}
                    {outputs.length > 0 && (
                      <div className="flex gap-2">
                        <dt className="text-tertiary">{t("research.agent.tool_output")}</dt>
                        <dd className="min-w-0 flex-1 break-words text-secondary">{outputs.join("；")}</dd>
                      </div>
                    )}
                  </dl>
                  <button
                    type="button"
                    onClick={() => api.jumpToEvent(event.seq)}
                    className="mt-2 text-11 text-accent-primary hover:underline"
                  >
                    {t("research.agent.open_trace")}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-11 text-tertiary">{t("research.agent.tools_empty")}</p>
        )}
      </section>

      <section className="border-b border-subtle p-4">
        <h3 className="text-12 font-semibold text-primary">{t("research.agent.artifacts_title")}</h3>
        <ul className="mt-3 space-y-2" role="list">
          {api.artifactEvents.map((event) => {
            const summary = agentPayloadText(event.payload, ["summary", "content", "artifact_type", "action"]);
            return (
              <li key={`artifact-${event.run_id}-${event.seq}`} className="rounded-md border border-subtle p-3">
                <p className="text-11 font-medium text-primary">{agentEventLabel(event.event_type, t)}</p>
                {summary && <p className="mt-1 text-11 text-secondary">{summary}</p>}
              </li>
            );
          })}
          {!api.artifactEvents.length && (
            <li className="text-11 text-tertiary">{t("research.agent.artifacts_empty")}</li>
          )}
        </ul>
      </section>

      <section className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-12 font-semibold text-primary">{t("research.agent.trace_title")}</h3>
          <div className="flex flex-wrap gap-2">
            <select
              value={api.traceTypeFilter}
              onChange={(event) => api.setTraceTypeFilter(event.target.value)}
              aria-label={t("research.agent.trace_type_filter")}
              className="rounded-md border border-subtle bg-surface-1 px-2 py-1 text-11 text-primary"
            >
              <option value="">{t("research.agent.trace_all_types")}</option>
              {api.traceTypes.map((type) => (
                <option key={type} value={type}>
                  {agentEventLabel(type, t)}
                </option>
              ))}
            </select>
            <select
              value={api.traceStatusFilter}
              onChange={(event) => api.setTraceStatusFilter(event.target.value)}
              aria-label={t("research.agent.trace_status_filter")}
              className="rounded-md border border-subtle bg-surface-1 px-2 py-1 text-11 text-primary"
            >
              <option value="">{t("research.agent.trace_all_statuses")}</option>
              {api.traceStatuses.map((status) => (
                <option key={status} value={status}>
                  {t(`research.agent.tool_status.${status.toLowerCase()}`)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <ol className="mt-3 space-y-2" role="list">
          {api.visibleEvents.map((event) => (
            <li key={`trace-${event.run_id}-${event.seq}`} className="flex items-center justify-between gap-2 text-11">
              <span className="min-w-0 truncate text-tertiary">
                <span className="font-medium text-secondary">#{event.seq}</span> {agentEventLabel(event.event_type, t)}
              </span>
              <button
                type="button"
                onClick={() => api.jumpToEvent(event.seq)}
                className="shrink-0 text-accent-primary hover:underline"
              >
                {t("research.agent.open_trace")}
              </button>
            </li>
          ))}
          {!api.visibleEvents.length && <li className="text-11 text-tertiary">{t("research.agent.trace_empty")}</li>}
        </ol>
      </section>
    </>
  );
}
