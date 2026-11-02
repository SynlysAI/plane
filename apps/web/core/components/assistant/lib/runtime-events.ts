/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TAgentDockEvent } from "@/services/agent-dock";

export type TRuntimeToolCall = {
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "waiting_approval";
  arguments: string;
  result: string;
  duration_ms: number | null;
  seq: number;
};

const SENSITIVE_MARKERS = ["password", "token", "secret", "api_key", "authorization", "cookie"];

/** Recursively redact credential-like fields and bound the preview size. */
export function safeRuntimePreview(value: unknown, depth = 0): string {
  if (depth > 4) return "…";
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 240)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value))
    return value
      .slice(0, 20)
      .map((item) => safeRuntimePreview(item, depth + 1))
      .join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 30)
      .map(([key, item]) => {
        const redacted = SENSITIVE_MARKERS.some((marker) => key.toLowerCase().includes(marker));
        return `${key}: ${redacted ? "[REDACTED]" : safeRuntimePreview(item, depth + 1)}`;
      })
      .join("\n");
  }
  return "";
}

function duration(startedAt: string | undefined, endedAt: string | undefined) {
  if (!startedAt || !endedAt) return null;
  const duration_ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(duration_ms) && duration_ms >= 0 ? duration_ms : null;
}

/** Merge tool calls/results by stable tool call id and keep a bounded safe preview. */
export function mergeRuntimeToolCalls(events: TAgentDockEvent[]): TRuntimeToolCall[] {
  const calls = new Map<string, TRuntimeToolCall>();
  for (const event of events) {
    if (event.event_type !== "TOOL_CALL") continue;
    const payload = event.payload ?? {};
    const request = payload.request as { id?: unknown } | undefined;
    const id = String(payload.tool_call_id ?? request?.id ?? event.seq);
    const status = String(payload.status ?? "RUNNING").toUpperCase();
    const current: TRuntimeToolCall = calls.get(id) ?? {
      id,
      name: String(payload.name ?? "tool"),
      status: status === "WAITING_APPROVAL" ? "waiting_approval" : "running",
      arguments: safeRuntimePreview(payload.arguments ?? payload.input_summary ?? ""),
      result: "",
      duration_ms: null,
      seq: event.seq,
    };
    current.name = String(payload.name ?? current.name);
    if (payload.arguments !== undefined) current.arguments = safeRuntimePreview(payload.arguments);
    if (payload.input_summary !== undefined) current.arguments = safeRuntimePreview(payload.input_summary);
    if (status === "COMPLETED" || status === "READY" || status === "SUCCESS") current.status = "completed";
    else if (status === "FAILED" || status === "ERROR" || status === "DEGRADED") current.status = "failed";
    else if (status === "WAITING_APPROVAL" || status === "PENDING") current.status = "waiting_approval";
    if (payload.summary || payload.output || payload.result || payload.content) {
      current.result = safeRuntimePreview(payload.summary ?? payload.output ?? payload.result ?? payload.content).slice(
        0,
        2000
      );
      const startedAt = events.find((item) => item.seq === current.seq)?.created_at;
      current.duration_ms = duration(startedAt, event.created_at);
    }
    current.seq = Math.min(current.seq, event.seq);
    calls.set(id, current);
  }
  return [...calls.values()].toSorted((left, right) => left.seq - right.seq);
}
