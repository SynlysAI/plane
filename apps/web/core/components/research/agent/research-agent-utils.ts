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

type TResearchAgentToolStatus = "READY" | "RUNNING" | "WAITING_APPROVAL" | "COMPLETED" | "FAILED" | "DEGRADED";
type TResearchAgentRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
type TResearchAgentTranslate = (key: string, params?: Record<string, unknown>) => string;

/** 聊天式消息条目：由原始事件流合并而来，驱动对话区分层渲染。 */
export type TAgentMessageItem =
  | { kind: "user"; key: string; text: string; seq: number }
  | { kind: "assistant"; key: string; text: string; seq: number; streaming: boolean }
  | { kind: "thinking"; key: string; text: string; seq: number }
  | { kind: "process"; key: string; label: string; seq: number }
  | { kind: "tool"; key: string; name: string; status: string; output: string; seq: number }
  | { kind: "artifact"; key: string; event: TAgentRunEvent }
  | { kind: "data_change"; key: string; label: string; seq: number; event: TAgentRunEvent }
  | { kind: "approval"; key: string; event: TAgentRunEvent }
  | { kind: "decision"; key: string; label: string; seq: number }
  | { kind: "notice"; key: string; label: string; seq: number; tone: "error" | "info" };

const PROCESS_REMOTE_TYPES = new Set([
  "run.queued",
  "run.status",
  "run.started",
  "agent.phase",
  "model.usage",
  "subagent.updated",
  "subagent.step",
  "subagent.usage",
  "assistant.response.started",
  "assistant.response.settled",
]);
const TOOL_OUTPUT_KEYS = ["chunk", "output", "result", "text", "content"];

/** 读取事件的远端原始类型（SD 事件方言）。 */
function eventRemoteType(event: TAgentRunEvent) {
  return String(event.payload.remote_type ?? "");
}

const RESEARCH_AGENT_EVENT_TYPE_LABELS: Record<string, string> = {
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

/**
 * 把原始事件流合并为聊天式消息条目（delta 拼接、completed 替换、工具归并）。
 *
 * Args:
 *   events: 按 seq 排序的 Agent 运行事件。
 *
 * Returns:
 *   分层消息条目数组（用户气泡 / AI 正文 / 思考 / 过程行 / 工具卡 / 产物卡 / 审批卡）。
 */
export function mergeAgentMessages(events: TAgentRunEvent[]): TAgentMessageItem[] {
  const items: TAgentMessageItem[] = [];
  const narrative = (event: TAgentRunEvent, keys: string[]) => agentPayloadText(event.payload, keys);

  for (const event of events) {
    const rt = eventRemoteType(event);
    const last = items[items.length - 1];
    switch (event.event_type.toUpperCase()) {
      case "COMMUNICATION": {
        items.push({
          kind: "user",
          key: `u-${event.seq}`,
          text: narrative(event, ["content"]) || `#${event.seq}`,
          seq: event.seq,
        });
        break;
      }
      case "OUTPUT": {
        const text =
          rt === "run.completed" ? narrative(event, ["content"]) : narrative(event, ["content", "delta", "text"]);
        if (!text) break;
        if (rt === "run.completed" && last?.kind === "assistant" && last.streaming) {
          // 终态全文替换本轮流式累积，避免同一段回答重复出现。
          items[items.length - 1] = { ...last, text, streaming: false, seq: event.seq };
        } else if (last?.kind === "assistant" && last.streaming) {
          items[items.length - 1] = { ...last, text: last.text + text };
        } else {
          items.push({
            kind: "assistant",
            key: `a-${event.seq}`,
            text,
            seq: event.seq,
            streaming: rt !== "run.completed",
          });
        }
        break;
      }
      case "AI_ACTION": {
        const thinking = rt.startsWith("assistant.thinking");
        const text = narrative(event, ["reasoning", "delta", "content", "summary", "message", "text"]);
        if (thinking && text && last?.kind === "thinking") {
          items[items.length - 1] = { ...last, text: last.text + text };
        } else if (thinking && text) {
          items.push({ kind: "thinking", key: `t-${event.seq}`, text, seq: event.seq });
        } else if (PROCESS_REMOTE_TYPES.has(rt) && !text) {
          items.push({ kind: "process", key: `p-${event.seq}`, label: rt, seq: event.seq });
        } else if (text) {
          items.push({ kind: "process", key: `p-${event.seq}`, label: text.slice(0, 120), seq: event.seq });
        }
        break;
      }
      case "TOOL_CALL": {
        if (event.payload.requires_approval === true) {
          items.push({ kind: "approval", key: `ap-${event.seq}`, event });
          break;
        }
        const trace = (event.payload.trace ?? {}) as Record<string, unknown>;
        const name = narrative(event, ["tool_name", "name"]) || String(trace.name ?? trace.toolName ?? "") || "tool";
        const output = narrative(event, TOOL_OUTPUT_KEYS);
        const toolId = String(
          trace.toolCallId ?? trace.id ?? event.payload.tool_call_id ?? event.payload.toolCallId ?? ""
        );
        if (toolId && last?.kind === "tool" && last.key === `tool-${toolId}`) {
          items[items.length - 1] = {
            ...last,
            output: output ? last.output + output : last.output,
            status: agentToolStatus(event.payload),
          };
        } else {
          items.push({
            kind: "tool",
            key: `tool-${toolId || event.seq}`,
            name,
            status: agentToolStatus(event.payload),
            output,
            seq: event.seq,
          });
        }
        break;
      }
      case "INTERMEDIATE_ARTIFACT": {
        items.push({ kind: "artifact", key: `art-${event.seq}`, event });
        break;
      }
      case "DATA_CHANGE": {
        const action = String(event.payload.action ?? "");
        const fileName = String(
          (event.payload.file_name as string | undefined) ?? (event.payload.sd_path as string | undefined) ?? ""
        );
        items.push({
          kind: "data_change",
          key: `d-${event.seq}`,
          label: fileName || action || "data",
          seq: event.seq,
          event,
        });
        break;
      }
      case "APPROVAL": {
        items.push({ kind: "approval", key: `ap-${event.seq}`, event });
        break;
      }
      case "HUMAN_DECISION": {
        const decision = String(event.payload.decision ?? event.payload.action ?? "");
        items.push({ kind: "decision", key: `h-${event.seq}`, label: decision, seq: event.seq });
        break;
      }
      case "DEGRADED": {
        const reason = narrative(event, ["reason", "content"]) || "degraded";
        items.push({ kind: "notice", key: `n-${event.seq}`, label: reason, seq: event.seq, tone: "error" });
        break;
      }
      default: {
        const text = narrative(event, ["summary", "content"]);
        if (text) {
          items.push({
            kind: "notice",
            key: `n-${event.seq}`,
            label: text.slice(0, 160),
            seq: event.seq,
            tone: "info",
          });
        }
      }
    }
  }
  return items;
}
