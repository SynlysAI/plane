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

    expect(items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    const assistant = items.find((item) => item.kind === "assistant");
    expect(assistant).toMatchObject({ text: "文献综述全文。", streaming: false });
  });

  it("协议生命周期事件不渲染为消息，settled 熄灭流式光标", () => {
    const items = mergeAgentMessages([
      event(1, "AI_ACTION", { remote_type: "run.queued" }),
      event(2, "AI_ACTION", { remote_type: "run.status", status: "running" }),
      event(3, "AI_ACTION", { remote_type: "run.started" }),
      event(4, "AI_ACTION", { remote_type: "agent.phase", phase: "thinking", turn: 1 }),
      event(5, "AI_ACTION", { remote_type: "agent.record", name: "context.captured" }),
      event(6, "AI_ACTION", { remote_type: "assistant.response.started", responseId: "r1", turn: 1 }),
      event(7, "OUTPUT", { remote_type: "assistant.delta", content: "部分回答" }),
      event(8, "AI_ACTION", { remote_type: "assistant.response.settled", responseId: "r1", turn: 1 }),
      event(9, "AI_ACTION", { remote_type: "run.status" }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["assistant"]);
    expect(items[0]).toMatchObject({ text: "部分回答", streaming: false });
  });

  it("真实方言：settled 之后 run.completed 全文不再打印两遍", () => {
    const full = "你好！我是你的学术研究助手，可以帮你完成全流程工作。";
    const items = mergeAgentMessages(
      [
        event(1, "COMMUNICATION", { direction: "user", content_hash: "h", length: 2 }),
        event(2, "AI_ACTION", { remote_type: "run.queued" }),
        event(3, "AI_ACTION", { remote_type: "run.status" }),
        event(4, "AI_ACTION", { remote_type: "run.started" }),
        event(5, "AI_ACTION", { remote_type: "agent.phase", phase: "thinking", turn: 1 }),
        event(6, "AI_ACTION", { remote_type: "assistant.response.started", responseId: "r1", turn: 1 }),
        event(7, "AI_ACTION", { remote_type: "assistant.thinking.delta", reasoning: "用户在打招呼" }),
        event(8, "OUTPUT", { remote_type: "assistant.delta", content: "你好！我是你的" }),
        event(9, "OUTPUT", { remote_type: "assistant.delta", content: "学术研究助手，可以帮你完成全流程工作。" }),
        event(10, "AI_ACTION", { remote_type: "assistant.response.settled", responseId: "r1", turn: 1 }),
        event(11, "OUTPUT", { remote_type: "run.completed", message: { content: full }, content: full }),
        event(12, "AI_ACTION", { remote_type: "run.status" }),
      ],
      { 1: "你好" }
    );

    const assistants = items.filter((item) => item.kind === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]).toMatchObject({ text: full, streaming: false });
    expect(items.map((item) => item.kind)).toEqual(["user", "thinking", "assistant"]);
    expect(items[0]).toMatchObject({ text: "你好" });
  });

  it("用户明文不落库：无回显时气泡回退为序号", () => {
    const items = mergeAgentMessages([event(1, "COMMUNICATION", { direction: "user", content_hash: "h", length: 6 })]);

    expect(items[0]).toMatchObject({ text: "#1" });
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

  it("SD 方言工具卡：trace 状态收敛、stdout 输出、跨事件归并", () => {
    const items = mergeAgentMessages([
      event(1, "TOOL_CALL", {
        remote_type: "tool.started",
        trace: { id: "call_x", name: "run_shell", status: "running", args: { command: "python3" } },
      }),
      // 中间夹 agent.record，归并不受相邻位置影响。
      event(2, "AI_ACTION", { remote_type: "agent.record", name: "state.committed" }),
      event(3, "TOOL_CALL", {
        remote_type: "tool.completed",
        trace: {
          id: "call_x",
          name: "run_shell",
          details: { state: "completed", result: { exitCode: 0, stdout: "8369910" } },
        },
      }),
    ]);

    const tools = items.filter((item) => item.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ name: "run_shell", status: "COMPLETED", output: "8369910" });
  });

  it("多轮对话：第二轮回答独立成块，不覆盖上一轮", () => {
    const items = mergeAgentMessages([
      event(1, "COMMUNICATION", { direction: "user", content: "第一问", content_hash: "h1", length: 3 }),
      event(2, "OUTPUT", { remote_type: "assistant.delta", content: "第一答" }),
      event(3, "AI_ACTION", { remote_type: "assistant.response.settled" }),
      event(4, "COMMUNICATION", { direction: "user", content: "第二问", content_hash: "h2", length: 3 }),
      event(5, "TOOL_CALL", {
        remote_type: "tool.started",
        trace: { id: "t9", name: "run_shell", status: "running" },
      }),
      event(6, "TOOL_CALL", {
        remote_type: "tool.completed",
        trace: { id: "t9", name: "run_shell", details: { state: "completed", result: { stdout: "42" } } },
      }),
      event(7, "OUTPUT", { remote_type: "run.completed", content: "第二答全文" }),
    ]);

    const assistants = items.filter((item) => item.kind === "assistant");
    expect(assistants.map((assistant) => assistant.text)).toEqual(["第一答", "第二答全文"]);
    expect(assistants[1]).toMatchObject({ streaming: false });
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
