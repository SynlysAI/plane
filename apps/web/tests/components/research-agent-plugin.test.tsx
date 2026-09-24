// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";
import type { TAgentRunEvent } from "@/services/research/agent.service";

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  getEvents: vi.fn(),
  cancelRun: vi.fn(),
  closeSession: vi.fn(),
  sendMessage: vi.fn(),
  saveArtifact: vi.fn(),
  decideApproval: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      let value: unknown = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      if (typeof value !== "string") return key;
      return value.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ""));
    },
  }),
}));

vi.mock("@/services/research/agent.service", () => ({
  ResearchAgentService: class {
    createSession = mocks.createSession;
    getEvents = mocks.getEvents;
    cancelRun = mocks.cancelRun;
    closeSession = mocks.closeSession;
    sendMessage = mocks.sendMessage;
    saveArtifact = mocks.saveArtifact;
    decideApproval = mocks.decideApproval;
  },
}));

const session = {
  schema_version: "agent-plugin.v1",
  session_id: "session-1",
  run_id: "run-1",
  workspace: "ws",
  user: "user-1",
  project: "project-1",
  chain_node: "node-1",
  context_id: "context-1",
  context_hash: "1234567890abcdef",
  status: "READY",
  last_error: "",
  synlora_session_id: "synlora-session-1",
  synlora_run_id: "",
  delegated_subject: "u_synlora",
  assembly: {
    persona: "research-general",
    enabled_plugins: [],
    allowed_tools: ["knowledge.search"],
    allowed_knowledge_base_ids: ["kb-1"],
    allowed_file_ids: [],
    unavailable_reasons: [],
    policy_id: "policy-1",
  },
  created_at: "2026-09-23T01:00:00Z",
  updated_at: "2026-09-23T01:00:00Z",
};

function event(seq: number, event_type: string): TAgentRunEvent {
  return {
    schema_version: "agent-plugin.v1",
    run_id: "run-1",
    seq,
    event_type,
    payload: { seq },
    request_id: `request-${seq}`,
    created_at: "2026-09-23T01:00:00Z",
  };
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.createSession.mockResolvedValue(session);
  mocks.getEvents.mockImplementation(async (_slug: string, _runId: string, afterSeq = 0) => ({
    results:
      afterSeq === 0 ? [event(1, "AI_ACTION"), event(1, "AI_ACTION")] : [event(1, "AI_ACTION"), event(2, "TOOL_CALL")],
    count: afterSeq === 0 ? 2 : 2,
    latest_seq: afterSeq === 0 ? 1 : 2,
  }));
  mocks.cancelRun.mockResolvedValue({ ...session, status: "CLOSED" });
  mocks.decideApproval.mockResolvedValue({
    session: { ...session, status: "READY" },
    event: event(4, "HUMAN_DECISION"),
  });
  mocks.saveArtifact.mockResolvedValue({
    snapshot_id: "snap-1",
    snapshot_type: "ANALYSIS_RESULT",
    version: 2,
    event: event(3, "DATA_CHANGE"),
  });
});

afterEach(() => {
  root.unmount();
  container.remove();
  vi.clearAllMocks();
});

it("merges cursor events, reconnects after the latest sequence, and stops generation", async () => {
  const { ResearchAgentPlugin } = await import("@/components/research/agent/research-agent-plugin");
  await act(async () => {
    root.render(<ResearchAgentPlugin workspaceSlug="lab" chainNodeId="node-1" />);
  });
  await act(async () => undefined);

  expect(container.textContent).toContain("最后事件 #1");
  expect(container.textContent).toContain("research-general");
  expect(container.textContent).toContain("knowledge.search");
  expect(mocks.getEvents).toHaveBeenCalledWith("lab", "run-1");
  expect(container.querySelectorAll("article").length).toBe(1);

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "重新连接")?.click();
  });
  expect(mocks.getEvents).toHaveBeenLastCalledWith("lab", "run-1", 1);
  expect(container.textContent).toContain("最后事件 #2");
  expect(container.querySelectorAll("article").length).toBe(2);
  expect(container.textContent).toContain("工具调用");

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "停止生成")?.click();
  });
  expect(mocks.cancelRun).toHaveBeenCalledWith("lab", "run-1");
  expect(container.textContent).toContain("已关闭");

  await act(async () => {
    root.render(null);
  });
  root.render(<ResearchAgentPlugin workspaceSlug="lab" chainNodeId="node-1" />);
  await act(async () => undefined);
  await act(async () => undefined);
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "预览产物")?.click();
  });
  const textarea = [...container.querySelectorAll("textarea")].at(-1);
  expect(textarea).not.toBeNull();
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    valueSetter?.call(textarea, "confirmed analysis");
    textarea?.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const checkbox = container.querySelector('input[type="checkbox"]');
  await act(async () => {
    (checkbox as HTMLInputElement | null)?.click();
  });
  await act(async () => {
    const saveButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "保存到科研链"
    );
    expect(saveButton?.disabled).toBe(false);
    saveButton?.click();
  });
  expect(mocks.saveArtifact).toHaveBeenCalledWith(
    "lab",
    "session-1",
    expect.objectContaining({ artifact_type: "ANALYSIS_SUMMARY", confirmed: true })
  );
  expect(container.textContent).toContain("ANALYSIS_RESULT v2");
});

it("renders structured approval cards and submits an idempotent Agent decision", async () => {
  const { ResearchAgentPlugin } = await import("@/components/research/agent/research-agent-plugin");
  mocks.createSession.mockResolvedValue({ ...session, status: "WAITING_APPROVAL" });
  mocks.getEvents.mockResolvedValue({
    results: [
      {
        ...event(2, "TOOL_CALL"),
        payload: {
          tool_name: "knowledge.search",
          status: "WAITING_APPROVAL",
          requires_approval: true,
          capability_scope: "chain-node:node-1",
          risk_level: "MEDIUM",
          input_summary: "检索聚合物 Tg 文献",
          output_refs: [{ title: "Polymer Tg dataset" }],
        },
      },
    ],
    count: 1,
    latest_seq: 2,
  });

  await act(async () => {
    root.render(<ResearchAgentPlugin workspaceSlug="lab" chainNodeId="node-1" />);
  });
  await act(async () => undefined);

  expect(container.textContent).toContain("knowledge.search");
  expect(container.textContent).toContain("等待审批");
  expect(container.textContent).toContain("检索聚合物 Tg 文献");
  expect(container.textContent).toContain("Polymer Tg dataset");
  expect(container.textContent).not.toContain('{"tool_name"');

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "处理审批")?.click();
  });
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "通过")?.click();
  });

  expect(mocks.decideApproval).toHaveBeenCalledWith(
    "lab",
    "run-1",
    expect.objectContaining({ decision: "APPROVED", tool_call_id: "2", reason: undefined })
  );
  expect(container.textContent).toContain("审批已通过，Agent 可继续执行。");
});
