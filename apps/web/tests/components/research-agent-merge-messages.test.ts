import { describe, expect, it } from "vitest";
// components
import { mergeAgentMessages } from "@/components/research/agent/research-agent-utils";
import type { TAgentRunEvent } from "@/services/research/agent.service";

function event(seq: number, eventType: string, payload: Record<string, unknown>): TAgentRunEvent {
  return {
    schema_version: "agent-plugin.v1",
    run_id: "run-1",
    seq,
    event_type: eventType,
    payload,
    request_id: `req-${seq}`,
    created_at: "2026-10-14T00:00:00Z",
  };
}

describe("mergeAgentMessages", () => {
  it("合并连续 assistant.delta 并用 run.completed 全文替换", () => {
    const items = mergeAgentMessages([
      event(1, "COMMUNICATION", { direction: "user", content: "帮我调研", content_hash: "h", length: 4 }),
      event(2, "AI_ACTION", { remote_type: "run.started" }),
      event(3, "OUTPUT", { remote_type: "assistant.delta", content: "文献" }),
      event(4, "OUTPUT", { remote_type: "assistant.delta", content: "综述" }),
      event(5, "OUTPUT", { remote_type: "run.completed", content: "文献综述全文。" }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["user", "process", "assistant"]);
    const assistant = items.find((item) => item.kind === "assistant");
    expect(assistant).toMatchObject({ text: "文献综述全文。", streaming: false });
  });

  it("思考过程连续拼接，工具事件按 toolCallId 归并输出", () => {
    const items = mergeAgentMessages([
      event(1, "AI_ACTION", { remote_type: "assistant.thinking.delta", reasoning: "先拆解" }),
      event(2, "AI_ACTION", { remote_type: "assistant.thinking.delta", reasoning: "问题" }),
      event(3, "TOOL_CALL", { remote_type: "tool.started", trace: { toolCallId: "t1", name: "read_file" } }),
      event(4, "TOOL_CALL", { remote_type: "tool.output", toolCallId: "t1", chunk: "abc" }),
    ]);

    const thinking = items.find((item) => item.kind === "thinking");
    expect(thinking).toMatchObject({ text: "先拆解问题" });
    const tools = items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "read_file", output: "abc" });
  });

  it("审批、产物、文件变更分别落位为对应卡片", () => {
    const items = mergeAgentMessages([
      event(1, "APPROVAL", { remote_type: "permission.required", requires_approval: true, request: { id: "p1" } }),
      event(2, "DATA_CHANGE", { action: "workspace.upload", file_name: "a.csv" }),
      event(3, "INTERMEDIATE_ARTIFACT", {
        remote_type: "artifact.upserted",
        artifact: { name: "r.md" },
        version: { id: "v1" },
      }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["approval", "data_change", "artifact"]);
    expect(items.find((item) => item.kind === "data_change")).toMatchObject({ label: "a.csv" });
  });
});
