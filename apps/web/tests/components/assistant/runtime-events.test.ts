/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { mergeRuntimeToolCalls, safeRuntimePreview } from "@/components/assistant/lib/runtime-events";
import type { TAgentDockEvent } from "@/services/agent-dock";

function event(seq: number, payload: Record<string, unknown>) {
  return {
    schema_version: "agent-dock-event.v1",
    run_id: "run-1",
    seq,
    event_type: "TOOL_CALL",
    payload,
    request_id: `request-${seq}`,
    created_at: new Date(Date.now() + seq * 1000).toISOString(),
  } satisfies TAgentDockEvent;
}

describe("runtime event display", () => {
  it("redacts credential-like arguments", () => {
    const preview = safeRuntimePreview({
      api_key: "sk-secret",
      nested: { authorization: "Bearer token", query: "polymer" },
    });
    expect(preview).toContain("api_key: [REDACTED]");
    expect(preview).toContain("authorization: [REDACTED]");
    expect(preview).toContain("query: polymer");
    expect(preview).not.toContain("sk-secret");
  });

  it("merges tool call and result by stable id", () => {
    const calls = mergeRuntimeToolCalls([
      event(1, { tool_call_id: "call-1", name: "knowledge.search", arguments: { query: "文献" }, status: "RUNNING" }),
      event(2, { tool_call_id: "call-1", name: "knowledge.search", status: "COMPLETED", summary: "12 条资料" }),
      event(3, { tool_call_id: "call-2", name: "http.request", arguments: { token: "secret" }, status: "FAILED" }),
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      id: "call-1",
      name: "knowledge.search",
      status: "completed",
      result: "12 条资料",
    });
    expect(calls[0].duration_ms).toBeGreaterThanOrEqual(0);
    expect(calls[1].status).toBe("failed");
    expect(calls[1].arguments).toContain("token: [REDACTED]");
  });
});
