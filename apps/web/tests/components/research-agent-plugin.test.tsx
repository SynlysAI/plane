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
  getFormalReports: vi.fn(),
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
    getFormalReports = mocks.getFormalReports;
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
  mocks.getFormalReports.mockResolvedValue({ results: [], association_hint: "无项目报告需先关联当前课题。" });
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
  vi.resetAllMocks();
});

it("merges cursor events, opens the runtime drawer, stops generation, and saves an SD artifact", async () => {
  const { ResearchAgentPlugin } = await import("@/components/research/agent/research-agent-plugin");
  await act(async () => {
    root.render(<ResearchAgentPlugin workspaceSlug="lab" chainNodeId="node-1" />);
  });
  await act(async () => undefined);

  // 初始加载与游标合并：重复事件只拉一次。
  expect(mocks.getEvents).toHaveBeenCalledWith("lab", "run-1");
  expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();

  // 运行详情抽屉：装配摘要与工具在抽屉内可达。
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("运行详情"))?.click();
  });
  const drawer = container.querySelector('aside[role="dialog"][aria-modal="true"]');
  expect(drawer).not.toBeNull();
  expect(drawer?.textContent).toContain("research-general");
  expect(drawer?.textContent).toContain("knowledge.search");

  // 停止按钮仅在 STREAMING 出现，点击后取消远端运行。
  await act(async () => {
    root.render(null);
  });
  mocks.createSession.mockResolvedValueOnce({ ...session, status: "STREAMING" });
  await act(async () => {
    root.render(<ResearchAgentPlugin workspaceSlug="lab" chainNodeId="node-1" />);
  });
  await act(async () => undefined);
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "停止生成")?.click();
  });
  expect(mocks.cancelRun).toHaveBeenCalledWith("lab", "run-1");

  // SD 产物卡：保存到节点 → 抽屉表单 → 确认保存。
  await act(async () => {
    root.render(null);
  });
  mocks.createSession.mockResolvedValueOnce({
    ...session,
    provider: "SCIENCE_DISCOVERY",
    status: "READY",
  });
  mocks.getEvents.mockResolvedValue({
    results: [
      {
        ...event(5, "INTERMEDIATE_ARTIFACT"),
        payload: {
          remote_type: "artifact.upserted",
          artifact: { name: "综述报告.md", kind: "report" },
          version: { id: "ver-1", mediaType: "text/markdown" },
        },
      },
    ],
    count: 1,
    latest_seq: 5,
  });
  await act(async () => {
    root.render(<ResearchAgentPlugin workspaceSlug="lab" chainNodeId="node-1" />);
  });
  await act(async () => undefined);
  expect(container.textContent).toContain("综述报告.md");
  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "保存到研究链")?.click();
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
    const saveButton = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent === "保存到研究链"
    );
    expect(saveButton?.disabled).toBe(false);
    saveButton?.click();
  });
  expect(mocks.saveArtifact).toHaveBeenCalledWith(
    "lab",
    "session-1",
    expect.objectContaining({
      artifact_type: "ANALYSIS_SUMMARY",
      confirmed: true,
      source_versions: expect.arrayContaining([expect.objectContaining({ version_id: "ver-1" })]),
    })
  );
});

it("shows the Chinese degradation path when Synlora session creation fails", async () => {
  mocks.createSession.mockRejectedValueOnce({
    error_code: "AGENT_UPSTREAM_NOT_CONFIGURED",
    message: "Synlora is unavailable.",
  });
  const { ResearchAgentPlugin } = await import("@/components/research/agent/research-agent-plugin");
  await act(async () => {
    root.render(<ResearchAgentPlugin workspaceSlug="lab" chainNodeId="node-1" />);
  });
  await act(async () => undefined);

  expect(container.textContent).toContain("智能体运行时尚未配置");
  expect(container.textContent).toContain("研究链功能仍可继续使用");
  expect(container.textContent).not.toContain("你没有访问当前科研对象的权限");
});

it("keeps polling backoff when an idle run returns an equivalent session payload", async () => {
  vi.useFakeTimers();
  mocks.createSession.mockResolvedValue({ ...session, status: "STREAMING" });
  mocks.getEvents.mockResolvedValue({
    results: [],
    count: 0,
    latest_seq: 0,
    session: { ...session, status: "STREAMING", updated_at: "2026-10-15T00:00:01Z" },
  });

  try {
    const { ResearchAgentPlugin } = await import("@/components/research/agent/research-agent-plugin");
    await act(async () => {
      root.render(<ResearchAgentPlugin workspaceSlug="lab" chainNodeId="node-1" />);
    });
    expect(mocks.getEvents).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.getEvents).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(mocks.getEvents).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.getEvents).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it("renders an inline approval card and submits an idempotent Agent decision", async () => {
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

  // 审批以消息流内联卡呈现：工具名、说明、三个决策按钮。
  expect(container.textContent).toContain("需要审批");
  expect(container.textContent).toContain("检索聚合物 Tg 文献");
  expect(container.textContent).toContain("批准一次");
  expect(container.textContent).toContain("批准并记住");
  expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();

  await act(async () => {
    [...container.querySelectorAll("button")].find((button) => button.textContent === "批准一次")?.click();
  });
  expect(mocks.decideApproval).toHaveBeenCalledWith(
    "lab",
    "run-1",
    expect.objectContaining({ decision: "APPROVED", tool_call_id: "2", reason: undefined })
  );
  expect(container.textContent).toContain("已通过");
});

it("keeps the side-panel layout condensed with collapsed runtime details", async () => {
  const { ResearchAgentPlugin } = await import("@/components/research/agent/research-agent-plugin");
  await act(async () => {
    root.render(<ResearchAgentPlugin workspaceSlug="lab" chainNodeId="node-1" variant="panel" />);
  });
  await act(async () => undefined);

  // 侧栏精简：一行上下文 + 折叠的运行详情；无最后事件计数。
  expect(container.textContent).toContain("project-1 · node-1");
  expect(container.textContent).not.toContain("最后事件");

  const runtimeDetails = [...container.querySelectorAll("details")].find((details) =>
    details.querySelector("summary")?.textContent?.includes("运行详情")
  );
  expect(runtimeDetails).not.toBeNull();
  runtimeDetails?.setAttribute("open", "true");
  expect(runtimeDetails?.textContent).toContain("research-general");
});
