// @vitest-environment jsdom
/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
  getContext: vi.fn(),
  createSession: vi.fn(),
  sendMessage: vi.fn(),
  getEvents: vi.fn(),
  streamEvents: vi.fn(),
  cancelRun: vi.fn(),
}));

vi.mock("@/services/agent-dock", () => ({
  AgentDockService: class {
    resolveContext = mocks.resolveContext;
    listSessions = mocks.listSessions;
    getSession = mocks.getSession;
    getContext = mocks.getContext;
    createSession = mocks.createSession;
    sendMessage = mocks.sendMessage;
    getEvents = mocks.getEvents;
    streamEvents = mocks.streamEvents;
    cancelRun = mocks.cancelRun;
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "lab" }),
  usePathname: () => "/lab/projects",
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock("@plane/i18n", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { AIAssistantPanel } = await import("@/components/assistant/ai-assistant-panel");
const { AIAssistantStore } = await import("@/store/ai-assistant");
const { StoreContext } = await import("@/lib/store-context");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const envelope = {
  schema_version: "agent-context-envelope.v1",
  context_id: "context-1",
  context_version: 1,
  status: "linked",
  target_type: "PROJECT",
  target_hierarchy: [
    { type: "workspace", id: "ws", title: "Lab" },
    { type: "project", id: "project-1", title: "新材料研究" },
  ],
  resources_summary: { total: 7, by_kind: { task: 3, file: 4 } },
  manifest_summary: {
    summary: "当前节点：表征分析",
    resources: [
      { kind: "file", id: "file-1", title: "谱图数据.csv", status: "READY", updated_at: "2026-11-03T00:00:00Z" },
    ],
  },
  capabilities: {
    agent: "Synlora workspace assistant",
    allowed_tools: ["knowledge.search", "file.read"],
    allowed_plugins: [],
    allowed_mcp_ids: [],
    allowed_knowledge_base_ids: ["kb-1"],
    allowed_file_ids: ["file-1"],
  },
  expiry: "2099-01-01T00:00:00Z",
  session_binding: { workspace_id: "ws", target_key: "project:project-1", user_id: "user-1" },
};

const session = {
  schema_version: "agent-dock-session.v1",
  session_id: "session-1",
  run_id: "run-1",
  target_type: "PROJECT",
  target_key: "project:project-1",
  context: { context_id: "context-1", context_version: 1, status: "linked", expires_at: "2099-01-01T00:00:00Z" },
  status: "READY",
  last_error: "",
  provider: "SYNLORA",
  assembly: {},
  latest_seq: 2,
  source_cursor: 2,
};

const event = (seq: number, event_type: string, payload: Record<string, unknown> = {}) => ({
  schema_version: "agent-dock-event.v1",
  run_id: "run-1",
  seq,
  event_type,
  payload,
  request_id: `request-${seq}`,
  created_at: "2026-11-02T00:00:00Z",
});

/** Build an SSE response that can finish normally or remain active until aborted. */
function sseResponse(
  events: Array<{ type: string; seq: number; payload?: Record<string, unknown> }>,
  signal?: AbortSignal,
  runId = "run-1"
) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const item of events) {
        const eventEnvelope = {
          schema_version: "agent-dock-event.v1",
          run_id: runId,
          seq: item.seq,
          source_seq: item.seq,
          created_at: "2026-11-02T00:00:00Z",
          event_type: item.type,
          raw_event_type: item.type,
          payload: item.payload ?? {},
        };
        controller.enqueue(
          encoder.encode(`event: ${item.type}\nid: ${item.seq}\ndata: ${JSON.stringify(eventEnvelope)}\n\n`)
        );
      }
      if (signal) signal.addEventListener("abort", () => controller.close(), { once: true });
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

const MARKDOWN_TABLE = [
  "| Category | Capability |",
  "| :--- | ---: |",
  "| Search | **Full text** |",
  "| Analysis | `SQL` |",
].join("\n");

let container: HTMLDivElement;
let root: Root;
let originalMatchMedia: typeof window.matchMedia | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  originalMatchMedia = window.matchMedia;
  window.localStorage.clear();
  mocks.resolveContext.mockReset().mockResolvedValue(envelope);
  mocks.getSession.mockReset().mockResolvedValue(session);
  mocks.getContext.mockReset().mockResolvedValue(envelope);
  mocks.createSession.mockReset().mockResolvedValue(session);
  mocks.sendMessage.mockReset().mockResolvedValue({ ...session, status: "STREAMING" });
  mocks.getEvents.mockReset().mockResolvedValue({
    results: [event(2, "OUTPUT", { content: "你好，世界" })],
    count: 1,
    latest_seq: 2,
    session,
  });
  mocks.streamEvents
    .mockReset()
    .mockImplementation((_workspace: string, _run: string, _cursor: number, signal: AbortSignal) =>
      Promise.resolve(
        sseResponse(
          [
            { type: "run.started", seq: 3 },
            { type: "output.delta", seq: 4, payload: { content: "你好，世界" } },
            { type: "run.completed", seq: 5 },
          ],
          signal
        )
      )
    );
  mocks.cancelRun.mockReset().mockResolvedValue({ ...session, status: "CLOSED" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("[id^='plane-portal'], .fixed.inset-0").forEach((node) => node.remove());
  vi.clearAllMocks();
  if (originalMatchMedia === undefined) delete (window as { matchMedia?: typeof window.matchMedia }).matchMedia;
  else window.matchMedia = originalMatchMedia;
});

/** Render a ready cloud panel by default, matching the production root's resolved status. */
function renderPanel(store: InstanceType<typeof AIAssistantStore>) {
  if (!store.status) store.setStatus({ enabled: true, ready: true, state: "ready" });
  act(() => {
    root.render(
      // eslint-disable-next-line react/jsx-no-constructed-context-values -- test-only provider value
      <StoreContext.Provider value={{ aiAssistant: store } as never}>
        <AIAssistantPanel
          workspaceSlug="lab"
          statusState={store.status?.state ?? "loading"}
          onRetryStatus={() => undefined}
        />
      </StoreContext.Provider>
    );
  });
}

async function waitForText(text: string, attempt = 0): Promise<void> {
  if (document.body.textContent?.includes(text)) return;
  if (attempt >= 40) {
    expect(document.body.textContent).toContain(text);
    return;
  }
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await waitForText(text, attempt + 1);
}

function typeAndSend(text = "介绍这个项目") {
  const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
  const sendButton = [...document.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "aiAssistant.send"
  ) as HTMLButtonElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("AIAssistantPanel", () => {
  it("creates a target-bound session and renders durable output", async () => {
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");

    typeAndSend();
    await waitForText("你好，世界");
    expect(document.body.textContent).toContain("介绍这个项目");
    expect(mocks.createSession).toHaveBeenCalledWith("lab", "context-1");
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "lab",
      "session-1",
      "介绍这个项目",
      expect.objectContaining({ route: expect.any(String), selectedText: "" })
    );
    expect(window.localStorage.getItem("PLANE_AI_ASSISTANT_THREAD_lab")).toBe("session-1");
  });

  it("shows setup guidance and disables cloud input before a personal token is saved", async () => {
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    store.setStatus({
      enabled: false,
      ready: false,
      credential_mode: "PERSONAL",
      state: "personal_credential_required",
    });
    renderPanel(store);
    await waitForText("aiAssistant.status_personal_credential_required");

    const setupLink = document.querySelector('a[href="/settings/profile/agent-configuration"]') as HTMLAnchorElement;
    expect(setupLink).not.toBeNull();
    expect((document.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    expect(mocks.resolveContext).not.toHaveBeenCalled();
  });

  it("renders floating mode as a non-modal panel that does not capture page events", async () => {
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");

    const portal = document.querySelector('[role="dialog"]') as HTMLElement;
    const panel = document.querySelector('[role="document"]') as HTMLElement;
    expect(portal.classList.contains("pointer-events-none")).toBe(true);
    expect(portal.querySelector(".bg-black\\/50")).toBeNull();
    expect(panel.classList.contains("pointer-events-auto")).toBe(true);
  });

  it("fills the available height in docked mode and closes while pinned", async () => {
    const mediaQuery = {
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    window.matchMedia = vi.fn(() => mediaQuery as unknown as MediaQueryList);

    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    store.setDockMode("docked");
    renderPanel(store);
    await waitForText("新材料研究");

    const dockedPanel = document.querySelector('[data-agent-dock-mode="docked"]') as HTMLElement;
    expect(dockedPanel.classList.contains("h-full")).toBe(true);
    await act(async () => {
      document
        .querySelector('[aria-label="aiAssistant.close"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('[data-agent-dock-mode="docked"]')).toBeNull();
    expect(store.isOpen).toBe(false);
  });

  it("cancels a busy run before starting a new conversation", async () => {
    mocks.streamEvents.mockImplementation((_workspace: string, _run: string, _cursor: number, signal: AbortSignal) =>
      Promise.resolve(
        sseResponse(
          [
            { type: "run.started", seq: 3 },
            { type: "output.delta", seq: 4, payload: { content: "处理中" } },
          ],
          signal
        )
      )
    );
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");

    typeAndSend();
    await waitForText("处理中");
    store.setActiveView("runtime");
    await act(async () => {
      document
        .querySelector('[aria-label="aiAssistant.new_conversation"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.cancelRun).toHaveBeenCalledWith("lab", "run-1");
    expect(window.localStorage.getItem("PLANE_AI_ASSISTANT_THREAD_lab")).toBeNull();
    expect(store.activeView).toBe("conversation");
  });

  it("ignores a late event from a stopped run after the next question starts", async () => {
    let staleController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    mocks.sendMessage
      .mockResolvedValueOnce({ ...session, status: "STREAMING", run_id: "run-1", source_cursor: 2 })
      .mockResolvedValueOnce({ ...session, status: "STREAMING", run_id: "run-2", source_cursor: 2 });
    mocks.streamEvents.mockImplementation((_workspace: string, runId: string, _cursor: number, signal: AbortSignal) => {
      if (runId === "run-1") {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                staleController = controller;
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          )
        );
      }
      return Promise.resolve(
        sseResponse(
          [
            { type: "run.started", seq: 3 },
            { type: "output.delta", seq: 4, payload: { content: "新轮次答案" } },
            { type: "run.completed", seq: 5 },
          ],
          signal,
          runId
        )
      );
    });

    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");

    typeAndSend("第一轮");
    await waitForText("正在处理…");
    await act(async () => {
      document
        .querySelector('[aria-label="aiAssistant.stop"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForText("已取消");

    typeAndSend("第二轮");
    await waitForText("新轮次答案");
    const late = {
      schema_version: "agent-dock-event.v1",
      run_id: "run-1",
      seq: 6,
      source_seq: 6,
      created_at: "2026-11-03T00:00:00Z",
      event_type: "output.delta",
      payload: { content: "旧轮次迟到" },
    };
    await act(async () => {
      staleController?.enqueue(encoder.encode(`event: output.delta\nid: 6\ndata: ${JSON.stringify(late)}\n\n`));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.body.textContent).not.toContain("旧轮次迟到");
    staleController?.close();
  });

  it("restores an existing dock session without leaking context bodies", async () => {
    window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab", "session-1");
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("你好，世界");
    expect(mocks.getSession).toHaveBeenCalledWith("lab", "session-1");
    expect(mocks.getContext).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.streamEvents).not.toHaveBeenCalled();
  });

  it("resumes an active run from the browser cursor instead of the persisted event cursor", async () => {
    const activeSession = {
      ...session,
      status: "STREAMING",
      source_cursor: 12,
      run_start_cursor: 5,
      assembly: { run_start_cursor: 5 },
    };
    mocks.getSession.mockResolvedValue(activeSession);
    mocks.getEvents.mockResolvedValue({
      results: [
        event(1, "TOOL_CALL", { remote_seq: 9, remote_type: "tool/call", name: "file.read", tool_call_id: "call-9" }),
      ],
      count: 1,
      latest_seq: 1,
      session: activeSession,
    });
    mocks.streamEvents.mockImplementation((_workspace: string, _run: string, _cursor: number, signal: AbortSignal) =>
      Promise.resolve(
        sseResponse(
          [
            { type: "output.delta", seq: 8, payload: { content: "恢复的增量" } },
            { type: "run.completed", seq: 13 },
          ],
          signal
        )
      )
    );
    window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab", "session-1");
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);

    await waitForText("恢复的增量");
    expect(mocks.streamEvents).toHaveBeenCalled();
    expect(mocks.streamEvents.mock.calls[0]?.[2]).toBe(5);
  });

  it("restores the completed phase from durable terminal events", async () => {
    mocks.getEvents.mockResolvedValue({
      results: [
        event(1, "OUTPUT", { remote_seq: 7, remote_type: "assistant.snapshot", content: "已保存回答", final: true }),
        event(2, "OUTPUT", { remote_seq: 8, remote_type: "run.completed", message: { content: "" } }),
      ],
      count: 2,
      latest_seq: 2,
      session,
    });
    window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab", "session-1");
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);

    await waitForText("已保存回答");
    expect(document.body.textContent).toContain("已完成");
    expect(mocks.streamEvents).not.toHaveBeenCalled();
  });

  it("keeps approval waiting state after the SSE reconnects", async () => {
    let connectionCount = 0;
    mocks.streamEvents.mockImplementation((_workspace: string, _run: string, _cursor: number, signal: AbortSignal) => {
      connectionCount += 1;
      if (connectionCount === 1) {
        return Promise.resolve(
          sseResponse([
            { type: "tool.started", seq: 3, payload: { name: "file.write", tool_call_id: "approval-call" } },
            { type: "approval.required", seq: 4, payload: { tool_call_id: "approval-call" } },
          ])
        );
      }
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener("abort", () => controller.close(), { once: true });
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } }
        )
      );
    });
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");

    typeAndSend();
    await waitForText("连接已断开，正在从最近事件位置恢复。");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1150));
    });

    expect(connectionCount).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).toContain("等待审批");
    expect(document.body.textContent).not.toContain("旧轮次");
  });

  it("renders markdown from durable assistant events", async () => {
    mocks.getEvents.mockResolvedValue({
      results: [event(2, "OUTPUT", { content: MARKDOWN_TABLE })],
      count: 1,
      latest_seq: 2,
      session,
    });
    window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab", "session-1");
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("Full text");
    const table = document.querySelector(".answer-markdown table");
    expect(table?.querySelector("strong")?.textContent).toBe("Full text");
    expect(table?.querySelector("code")?.textContent).toBe("SQL");
  });

  it("shows the target hierarchy and authorized capability counts in context view", async () => {
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "aiAssistant.view_context")
        ?.click();
    });
    expect(document.body.textContent).toContain("Lab / 新材料研究");
    expect(document.body.textContent).toContain("7");
    expect(document.body.textContent).toContain("2");
    expect(document.body.textContent).toContain("当前节点：表征分析");
    expect(document.body.textContent).toContain("谱图数据.csv");
    expect(document.body.textContent).toContain("尚未读取");
  });

  it("shows actual context access evidence after a read tool event", async () => {
    mocks.streamEvents.mockImplementation((_workspace: string, _run: string, _cursor: number, signal: AbortSignal) =>
      Promise.resolve(
        sseResponse(
          [
            {
              type: "context.accessed",
              seq: 3,
              payload: { name: "file.read", resource_id: "file-1", status: "completed" },
            },
            { type: "run.completed", seq: 4 },
          ],
          signal
        )
      )
    );
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");

    typeAndSend();
    await waitForText("已完成");
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent === "aiAssistant.view_context")
        ?.click();
    });
    expect(document.body.textContent).toContain("file.read");
    expect(document.body.textContent).toContain("file-1");
    expect(document.body.textContent).not.toContain("尚未读取");
  });

  it("uses a themed surface instead of the application canvas", async () => {
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");
    const panel = document.querySelector('[role="document"]');
    expect(panel?.classList.contains("bg-surface-1")).toBe(true);
    expect(panel?.classList.contains("bg-canvas")).toBe(false);
  });

  it("shows an inline error when event replay fails", async () => {
    mocks.getEvents.mockRejectedValue(new Error("agent_dock_http_502"));
    window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab", "session-1");
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("session_unavailable");
  });

  it("resets a stale cross-account session without showing unavailable", async () => {
    mocks.getSession.mockRejectedValueOnce(Object.assign(new Error("not found"), { error: "agent_session_not_found" }));
    window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab", "session-1");
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");

    expect(document.body.textContent).not.toContain("session_unavailable");
    expect(store.threadId).toBeNull();
    expect(window.localStorage.getItem("PLANE_AI_ASSISTANT_THREAD_lab")).toBeNull();
  });

  it("refreshes an expired context before sending", async () => {
    mocks.resolveContext
      .mockResolvedValueOnce({ ...envelope, expiry: "2000-01-01T00:00:00Z" })
      .mockResolvedValue({ ...envelope, context_id: "context-2" });
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");

    typeAndSend();
    await waitForText("你好，世界");

    expect(mocks.resolveContext.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("stops reconnecting after a protocol-level SSE failure", async () => {
    mocks.streamEvents.mockRejectedValue(
      Object.assign(new Error("not acceptable"), { status: 406, detail: { error: "not_acceptable" } })
    );
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");

    typeAndSend();
    await waitForText("stream_not_acceptable");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(mocks.streamEvents).toHaveBeenCalledTimes(1);
  });
});
