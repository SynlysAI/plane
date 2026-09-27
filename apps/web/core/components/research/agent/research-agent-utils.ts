import type { TResearchAgentSession } from "@plane/types";
// services
import type { TAgentRunEvent } from "@/services/research/agent.service";

export type TResearchAgentPluginState =
  | "loading_context"
  | "ready"
  | "streaming"
  | "waiting_approval"
  | "degraded"
  | "forbidden"
  | "error"
  | "closed";

export type TResearchAgentToolStatus = "READY" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "FAILED" | "DEGRADED";
export type TResearchAgentRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
export type TResearchAgentTranslate = (key: string, params?: Record<string, unknown>) => string;

export const RESEARCH_AGENT_EVENT_TYPE_LABELS: Record<string, string> = {
  AI_ACTION: "research.agent.event_ai_action",
  DATA_CHANGE: "research.agent.event_data_change",
  INTERMEDIATE_ARTIFACT: "research.agent.event_intermediate_artifact",
  VALIDATION: "research.agent.event_validation",
  VALIDATION_PASSED: "research.agent.event_validation_passed",
  VALIDATION_FAILED: "research.agent.event_validation_failed",
  HUMAN_DECISION: "research.agent.event_human_decision",
  APPROVAL: "research.agent.event_approval",
  DEGRADED: "research.agent.event_degraded",
  OUTPUT: "research.agent.event_output",
  NODE_CREATED: "research.agent.event_node_created",
};

/** Merge Agent events by the stable `(run_id, seq)` cursor. */
export function mergeAgentEvents(current: TAgentRunEvent[], incoming: TAgentRunEvent[]) {
  const merged = new Map(current.map((event) => [`${event.run_id}:${event.seq}`, event]));
  for (const event of incoming) merged.set(`${event.run_id}:${event.seq}`, event);
  // eslint-disable-next-line unicorn/no-array-sort
  return [...merged.values()].sort((left, right) => left.seq - right.seq);
}

/** Read the first human-readable string from known payload fields. */
export function agentPayloadText(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/** Normalize tool status while preventing unknown backend codes from reaching the UI. */
export function agentToolStatus(payload: Record<string, unknown>): TResearchAgentToolStatus {
  const value = String(payload.status ?? payload.state ?? "").toUpperCase();
  if (value === "PENDING" || value === "WAITING" || value === "WAITING_APPROVAL") return "WAITING_APPROVAL";
  if (value === "RUNNING" || value === "STREAMING") return "RUNNING";
  if (value === "SUCCESS" || value === "COMPLETED" || value === "READY") return "COMPLETED";
  if (value === "FAILED" || value === "ERROR") return "FAILED";
  if (value === "DEGRADED") return "DEGRADED";
  return "READY";
}

/** Normalize risk levels for structured tool cards. */
export function agentRiskLevel(payload: Record<string, unknown>): TResearchAgentRiskLevel {
  const value = String(payload.risk_level ?? payload.risk ?? "").toUpperCase();
  if (value === "LOW" || value === "MEDIUM" || value === "HIGH") return value;
  return "UNKNOWN";
}

/** Translate known event types and collapse unknown codes into a stable label. */
export function agentEventLabel(eventType: string, t: TResearchAgentTranslate) {
  const key = RESEARCH_AGENT_EVENT_TYPE_LABELS[eventType.toUpperCase()];
  return t(key ?? "research.agent.event_unknown");
}

/** Extract readable references without dumping raw JSON arrays. */
export function agentPayloadReferences(payload: Record<string, unknown>, keys: string[]) {
  return keys
    .flatMap((key) => {
      const value = payload[key];
      if (Array.isArray(value)) {
        return value.map((item) =>
          typeof item === "string"
            ? item
            : (["title", "name", "summary", "source", "url"]
                .map((field) => (item as Record<string, unknown>)?.[field])
                .find((candidate): candidate is string => typeof candidate === "string" && Boolean(candidate)) ?? "")
        );
      }
      return typeof value === "string" ? [value] : [];
    })
    .filter(Boolean)
    .slice(0, 4);
}

/** Derive a stable UI state from the authoritative Agent session. */
export function researchAgentSessionState(session: TResearchAgentSession): TResearchAgentPluginState {
  if (session.status === "WAITING_APPROVAL") return "waiting_approval";
  if (session.status === "STREAMING" || session.status === "SAVING") return "streaming";
  if (session.status === "DEGRADED") return "degraded";
  if (session.status === "ERROR") return "error";
  if (session.status === "CLOSED") return "closed";
  return "ready";
}
