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
  getSessionEvents: vi.fn(),
  streamEvents: vi.fn(),
  cancelRun: vi.fn(),
  answerRun: vi.fn(),
  toggleProfileSettingsModal: vi.fn(),
}));

const routerPush = vi.fn();

vi.mock("@/services/agent-dock", () => ({
  AgentDockService: class {
    resolveContext = mocks.resolveContext;
    listSessions = mocks.listSessions;
    getSession = mocks.getSession;
    getContext = mocks.getContext;
    createSession = mocks.createSession;
    sendMessage = mocks.sendMessage;
    getEvents = mocks.getEvents;
    getSessionEvents = mocks.getSessionEvents;
    streamEvents = mocks.streamEvents;
    cancelRun = mocks.cancelRun;
    answerRun = mocks.answerRun;
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "lab" }),
  usePathname: () => currentPath,
  useRouter: () => ({ push: routerPush }),
}));

let currentPath = "/lab/projects";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

vi.mock("@plane/i18n", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/store/use-command-palette", () => ({
  useCommandPalette: () => ({ toggleProfileSettingsModal: mocks.toggleProfileSettingsModal }),
}));

const { AIAssistantPanel } = await import("@/components/assistant/ai-assistant-panel");
const { AIAssistantStore } = await import("@/store/ai-assistant");
const { StoreContext } = await import("@/lib/store-context");
const { invalidateBackendAvailability } = await import("@/components/assistant/lib/backend-availability");

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
  currentPath = "/lab/projects";
  routerPush.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  originalMatchMedia = window.matchMedia;
  window.localStorage.clear();
  window.sessionStorage.clear();
  mocks.resolveContext.mockReset().mockResolvedValue(envelope);
  mocks.listSessions.mockReset().mockResolvedValue({ results: [], count: 0 });
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
  mocks.getSessionEvents.mockReset().mockImplementation(() => mocks.getEvents("lab", "run-1", 0));
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
  mocks.answerRun.mockReset().mockResolvedValue({ ...session, status: "STREAMING" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("[id^='plane-portal'], .fixed.inset-0").forEach((node) => node.remove());
  vi.clearAllMocks();
  window.sessionStorage.clear();
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

describe("AIAssistantPanel providers", () => {
  beforeEach(() => {
    mocks.resolveContext.mockImplementation(async (_workspace, _route, _text, _focus, provider = "SYNLORA") => ({
      ...envelope,
      provider,
      science_discovery: { available: true, reason: "" },
    }));
  });

  it("ignores a session creation response after switching providers", async () => {
    let complete: ((value: typeof session) => void) | undefined;
    mocks.createSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");
    typeAndSend("启动云端研究");
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.createSession).toHaveBeenCalled();
    await act(async () => {
      store.setProvider("local");
    });
    await act(async () => {
      complete?.(session);
    });
    expect(store.activeProvider).toBe("local");
    expect(store.threadId).toBeNull();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("启动云端研究");
  });

  it("uses local BFF on an ordinary page while cloud credentials are unavailable", async () => {
    const localSession = { ...session, provider: "SCIENCE_DISCOVERY" };
    mocks.createSession.mockResolvedValue(localSession);
    mocks.sendMessage.mockResolvedValue({ ...localSession, status: "STREAMING" });
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.setStatus({ enabled: true, ready: false, state: "personal_credential_required" });
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");
    const select = document.querySelector('[aria-label="aiAssistant.provider"]') as HTMLSelectElement;
    expect(select.options[1].disabled).toBe(false);
    await act(async () => {
      select.value = "local";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector("textarea")).not.toBeNull();
    expect(store.contextNodeId).toBeNull();
    typeAndSend("读取工作区资料");
    await waitForText("你好，世界");
    expect(mocks.createSession).toHaveBeenCalledWith("lab", "context-1", "SCIENCE_DISCOVERY");
    expect(mocks.sendMessage.mock.calls[0][3].provider).toBe("SCIENCE_DISCOVERY");
  });

  it("disables an unconfigured local backend and links to backend settings", async () => {
    mocks.resolveContext.mockResolvedValue({
      ...envelope,
      provider: "SYNLORA",
      science_discovery: { available: false, reason: "science_discovery_not_configured" },
    });
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");
    const select = document.querySelector('[aria-label="aiAssistant.provider"]') as HTMLSelectElement;
    expect(select.options[1].disabled).toBe(true);
    const button = [...document.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("aiAssistant.configure_local")
    );
    expect(button).toBeDefined();
    act(() => button?.click());
    expect(mocks.toggleProfileSettingsModal).toHaveBeenCalledWith({ activeTab: "agent-configuration", isOpen: true });
    expect(store.activeProvider).toBe("cloud");
  });

  it("restores SD history from another provider with deltas and snapshots merged once", async () => {
    const localSession = {
      ...session,
      provider: "SCIENCE_DISCOVERY",
      session_id: "local-history",
      target_title: "工作区科研助手",
      updated_at: "2026-11-05T00:00:00Z",
    };
    globalThis.sessionStorage.setItem(
      "PLANE_AGENT_DOCK_LAUNCH_HISTORY_lab:anonymous",
      JSON.stringify({ launchId: "launch", sessionIds: [localSession.session_id] })
    );
    mocks.listSessions.mockResolvedValue({ results: [localSession], count: 1 });
    mocks.getSession.mockResolvedValue(localSession);
    mocks.getEvents.mockResolvedValue({
      results: [
        event(1, "USER_MESSAGE", { content: "历史研究问题" }),
        event(2, "OUTPUT", { content: "草稿", remote_type: "assistant.delta", remote_seq: 1 }),
        event(3, "OUTPUT", { content: "补充", remote_type: "assistant.delta", remote_seq: 2 }),
        event(4, "OUTPUT", { content: "完整研究回答", remote_type: "assistant.snapshot", remote_seq: 3 }),
        event(5, "OUTPUT", { content: "完整研究回答", remote_type: "run.completed", remote_seq: 4 }),
      ],
      session: localSession,
    });
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");
    await act(async () => {
      document
        .querySelector('[aria-label="aiAssistant.launch_history"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForText("aiAssistant.provider_badge_local");
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("工作区科研助手"))
        ?.click();
    });
    await waitForText("完整研究回答");
    expect(store.activeProvider).toBe("local");
    expect(store.threadId).toBe("local-history");
    expect(document.body.textContent?.match(/完整研究回答/g)).toHaveLength(1);
    expect(document.body.textContent).not.toContain("草稿补充");
  });

  it("resumes a running SD session after refresh and replays permission requests", async () => {
    const localSession = { ...session, provider: "SCIENCE_DISCOVERY", status: "WAITING_APPROVAL", run_start_cursor: 0 };
    mocks.getSession.mockResolvedValue(localSession);
    mocks.getEvents.mockResolvedValue({
      results: [
        event(1, "USER_MESSAGE", { content: "继续实验" }),
        event(2, "OUTPUT", { content: "进行中", remote_type: "assistant.delta", remote_seq: 1 }),
        event(3, "APPROVAL", {
          remote_type: "permission.required",
          remote_seq: 2,
          request: { id: "permission-1", summary: "运行分析" },
        }),
      ],
      session: localSession,
    });
    mocks.streamEvents.mockImplementation((_workspace, _run, _cursor, signal) =>
      Promise.resolve(sseResponse([], signal))
    );
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.setProvider("local");
    store.setThreadId("lab", "session-1");
    store.open();
    renderPanel(store);
    await waitForText("aiAssistant.approval_pending");
    expect(mocks.streamEvents).toHaveBeenCalledWith("lab", "run-1", 2, expect.any(AbortSignal));
    expect(document.body.textContent).toContain("进行中");
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("replays paginated rounds with independent source sequences and resumes only the current run", async () => {
    const localSession = {
      ...session,
      provider: "SCIENCE_DISCOVERY",
      run_id: "run-2",
      status: "STREAMING",
      run_start_cursor: 0,
    };
    mocks.getSession.mockResolvedValue({ ...localSession, run_id: "run-1" });
    const firstRound = [
      event(1, "USER_MESSAGE", { content: "第一轮问题" }),
      event(2, "OUTPUT", { content: "第一轮回答", remote_type: "assistant.snapshot", remote_seq: 1 }),
      event(3, "OUTPUT", { remote_type: "run.completed", remote_seq: 2 }),
    ];
    const secondRound = [
      { ...event(4, "USER_MESSAGE", { content: "第二轮问题" }), run_id: "run-2" },
      {
        ...event(5, "OUTPUT", { content: "第二轮进行中", remote_type: "assistant.delta", remote_seq: 1 }),
        run_id: "run-2",
      },
    ];
    mocks.getSessionEvents.mockImplementation(async (_workspace, _session, cursor) => ({
      results: cursor ? [...firstRound.slice(-1), ...secondRound] : firstRound,
      next_cursor: cursor ? null : "page-2",
      session: localSession,
    }));
    mocks.streamEvents.mockImplementation((_workspace, runId, _cursor, signal) =>
      Promise.resolve(sseResponse([], signal, runId))
    );
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.setProvider("local");
    store.setThreadId("lab", "session-1");
    store.open();
    renderPanel(store);
    await waitForText("第二轮进行中");
    expect(document.body.textContent?.match(/第一轮回答/g)).toHaveLength(1);
    expect(document.body.textContent).toContain("第一轮问题");
    expect(document.body.textContent).toContain("第二轮问题");
    expect(document.querySelector('[aria-label="aiAssistant.stop"]')).not.toBeNull();
    expect(mocks.streamEvents).toHaveBeenLastCalledWith("lab", "run-2", 1, expect.any(AbortSignal));
  });

  it("keeps saved SD history readable when the backend is unavailable", async () => {
    const localSession = { ...session, provider: "SCIENCE_DISCOVERY", status: "STREAMING" };
    mocks.resolveContext.mockResolvedValue({ ...envelope, science_discovery: { available: false, reason: "offline" } });
    mocks.getSession.mockResolvedValue(localSession);
    mocks.getSessionEvents.mockResolvedValue({
      results: [
        event(1, "USER_MESSAGE", { content: "离线历史问题" }),
        event(2, "OUTPUT", {
          content: "已保存的科研回答",
          remote_type: "assistant.snapshot",
          remote_seq: 1,
        }),
      ],
      session: localSession,
    });
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.setProvider("local");
    store.setThreadId("lab", "session-1");
    store.open();
    renderPanel(store);
    await waitForText("aiAssistant.history_read_only");
    await waitForText("已保存的科研回答");
    expect(document.body.textContent).toContain("离线历史问题");
    expect((document.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    expect(mocks.streamEvents).not.toHaveBeenCalled();
    expect(store.threadId).toBe("session-1");
  });

  it("revalidates backend availability after settings change and while a run is active", async () => {
    mocks.resolveContext.mockResolvedValue({ ...envelope, science_discovery: { available: false, reason: "missing" } });
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");
    expect(
      (document.querySelector('[aria-label="aiAssistant.provider"]') as HTMLSelectElement).options[1].disabled
    ).toBe(true);
    mocks.resolveContext.mockResolvedValue({ ...envelope, science_discovery: { available: true, reason: "" } });
    await act(async () => invalidateBackendAvailability("lab"));
    expect(
      (document.querySelector('[aria-label="aiAssistant.provider"]') as HTMLSelectElement).options[1].disabled
    ).toBe(false);
    mocks.streamEvents.mockImplementation((_workspace, runId, _cursor, signal) =>
      Promise.resolve(sseResponse([], signal, runId))
    );
    typeAndSend("运行期间重验");
    await act(async () => {
      await Promise.resolve();
    });
    mocks.resolveContext.mockResolvedValue({ ...envelope, science_discovery: { available: false, reason: "deleted" } });
    await act(async () => invalidateBackendAvailability("lab"));
    expect(
      (document.querySelector('[aria-label="aiAssistant.provider"]') as HTMLSelectElement).options[1].disabled
    ).toBe(true);
    expect(document.querySelector('[aria-label="aiAssistant.stop"]')).not.toBeNull();
  });

  it("submits the displayed permission identity and ignores a late approval failure after provider change", async () => {
    const localSession = { ...session, provider: "SCIENCE_DISCOVERY", status: "WAITING_APPROVAL" };
    mocks.getSession.mockResolvedValue(localSession);
    mocks.getSessionEvents.mockResolvedValue({
      results: [1, 2].map((index) =>
        event(index, "APPROVAL", {
          remote_type: "permission.required",
          remote_seq: index,
          request: {
            id: `permission-${index}`,
            toolCallId: `tool-${index}`,
            summary: `写入结果 ${index}`,
            action: "write",
            resource: `/workspace/result-${index}.txt`,
          },
        })
      ),
      session: localSession,
    });
    mocks.streamEvents.mockImplementation((_workspace, runId, _cursor, signal) =>
      Promise.resolve(sseResponse([], signal, runId))
    );
    let rejectApproval: ((reason?: unknown) => void) | undefined;
    mocks.answerRun.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectApproval = reject;
        })
    );
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.setProvider("local");
    store.setThreadId("lab", "session-1");
    store.open();
    renderPanel(store);
    await waitForText("写入结果 2");
    expect(document.body.textContent).toContain("/workspace/result-1.txt");
    const allow = [...document.querySelectorAll("button")].filter((item) =>
      item.textContent?.includes("aiAssistant.approve")
    );
    expect(allow).toHaveLength(2);
    await act(async () => allow[0].click());
    expect(mocks.answerRun).toHaveBeenCalledWith("lab", "run-1", true, "permission-1");
    await act(async () => store.setProvider("cloud"));
    await act(async () => rejectApproval?.(new Error("late approval failure")));
    expect(document.body.textContent).not.toContain("aiAssistant.error_approval_answer_failed");
    expect(document.body.textContent).not.toContain("写入结果 1");
  });

  it("shows approval summary, action and resource in persisted runtime history", async () => {
    const localSession = { ...session, provider: "SCIENCE_DISCOVERY" };
    mocks.getSession.mockResolvedValue(localSession);
    mocks.getSessionEvents.mockResolvedValue({
      results: [
        event(1, "APPROVAL", {
          remote_type: "permission.required",
          remote_seq: 1,
          request: {
            id: "permission-1",
            toolCallId: "tool-1",
            summary: "保存核验报告",
            action: "write",
            resource: "/workspace/reports/confirmed.txt",
          },
        }),
        event(2, "HUMAN_DECISION", {
          remote_type: "permission.resolved",
          remote_seq: 2,
          requestId: "permission-1",
        }),
      ],
      session: localSession,
    });
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.setProvider("local");
    store.setThreadId("lab", "session-1");
    store.setActiveView("runtime");
    store.open();
    renderPanel(store);
    await waitForText("保存核验报告");
    expect(document.body.textContent).toContain("write");
    expect(document.body.textContent).toContain("/workspace/reports/confirmed.txt");
    expect(document.body.textContent).toContain("aiAssistant.approval_resolved");
    expect(
      [...document.querySelectorAll("button")].some((button) => button.textContent?.includes("aiAssistant.approve"))
    ).toBe(false);
  });

  it("discards a late SSE connection response after switching provider", async () => {
    let resolveStream: ((response: Response) => void) | undefined;
    mocks.streamEvents.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveStream = resolve;
        })
    );
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");
    typeAndSend("等待云端连接");
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.streamEvents).toHaveBeenCalledOnce();
    await waitForText("正在连接…");
    const localSession = { ...session, provider: "SCIENCE_DISCOVERY" };
    mocks.getSession.mockResolvedValue(localSession);
    mocks.getSessionEvents.mockResolvedValue({
      results: [event(2, "OUTPUT", { content: "你好，世界" })],
      session: localSession,
    });
    await act(async () => {
      store.setThreadId("lab", "local-session", "local");
      store.setProvider("local");
    });
    await waitForText("你好，世界");
    const cancelBody = vi.fn();
    await act(async () => {
      resolveStream?.(
        new Response(new ReadableStream<Uint8Array>({ cancel: cancelBody }), {
          headers: { "Content-Type": "text/event-stream" },
        })
      );
      await Promise.resolve();
    });
    expect(cancelBody).toHaveBeenCalledOnce();
    expect(document.querySelector('[aria-label="aiAssistant.stop"]')).toBeNull();
    expect(document.querySelector('[aria-label="aiAssistant.send"]')).not.toBeNull();
  });

  it("ignores a late cancellation after another provider has started its run", async () => {
    mocks.streamEvents.mockImplementation((_workspace, runId, _cursor, signal) =>
      Promise.resolve(sseResponse([], signal, runId))
    );
    let finishCancel: ((value: typeof session) => void) | undefined;
    mocks.cancelRun.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCancel = resolve;
        })
    );
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");
    typeAndSend("云端任务");
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => (document.querySelector('[aria-label="aiAssistant.stop"]') as HTMLButtonElement).click());
    expect(mocks.cancelRun).toHaveBeenCalledWith("lab", "run-1");
    const localSession = { ...session, provider: "SCIENCE_DISCOVERY", session_id: "sd-session", run_id: "sd-run" };
    mocks.createSession.mockResolvedValue(localSession);
    mocks.sendMessage.mockResolvedValue({ ...localSession, status: "STREAMING" });
    await act(async () => store.setProvider("local"));
    typeAndSend("本地任务");
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => finishCancel?.(session));
    expect(document.querySelector('[aria-label="aiAssistant.stop"]')).not.toBeNull();
    await act(async () => (document.querySelector('[aria-label="aiAssistant.stop"]') as HTMLButtonElement).click());
    expect(mocks.cancelRun).toHaveBeenLastCalledWith("lab", "sd-run");
  });

  it("ignores an older history load after a newer snapshot has completed", async () => {
    let finishOldHistory: ((value: unknown) => void) | undefined;
    mocks.getSessionEvents.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldHistory = resolve;
        })
    );
    mocks.getSessionEvents.mockResolvedValue({
      results: [event(2, "OUTPUT", { content: "最新历史快照" })],
      session,
    });
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.setThreadId("lab", "session-1");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");
    await act(async () => invalidateBackendAvailability("lab"));
    await waitForText("最新历史快照");
    await act(async () =>
      finishOldHistory?.({
        results: [event(2, "OUTPUT", { content: "迟到的旧历史快照" })],
        session,
      })
    );
    expect(document.body.textContent).toContain("最新历史快照");
    expect(document.body.textContent).not.toContain("迟到的旧历史快照");
  });
});

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
    expect(mocks.createSession).toHaveBeenCalledWith("lab", "context-1", "SYNLORA");
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

    const setupButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "aiAssistant.configure_token"
    ) as HTMLButtonElement;
    expect(setupButton).toBeDefined();
    await act(async () => {
      setupButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mocks.toggleProfileSettingsModal).toHaveBeenCalledWith({
      activeTab: "agent-configuration",
      isOpen: true,
    });
    expect((document.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    expect(mocks.resolveContext).toHaveBeenCalledWith("lab", currentPath, "", undefined, "SYNLORA");
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("renders floating mode as a non-modal panel that does not capture page events", async () => {
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");

    const panel = document.querySelector('[data-testid="assistant-panel"]') as HTMLElement;
    expect(document.querySelector(".bg-black\\/50")).toBeNull();
    expect(panel.classList.contains("bg-surface-1")).toBe(true);
  });

  it("shows and restores sessions from this browser launch batch", async () => {
    globalThis.sessionStorage.setItem(
      "PLANE_AGENT_DOCK_LAUNCH_HISTORY_lab:anonymous",
      JSON.stringify({ launchId: "launch-1", sessionIds: ["session-2"] })
    );
    const historySession = {
      ...session,
      session_id: "session-2",
      status: "READY",
      updated_at: "2026-11-04T12:00:00Z",
      target_title: "新材料研究",
      target_metadata: {
        workspace: { id: "ws", slug: "lab", name: "Lab" },
        target: { type: "PROJECT", id: "project-1", title: "新材料研究", hierarchy: [] },
        page: {
          route: "/lab/projects/project-1",
          page_kind: "project",
          focus_id: "project-1",
          focus_title: "新材料研究",
          hash: "hash",
          generated_at: "2026-11-04T11:00:00Z",
        },
      },
    };
    mocks.listSessions.mockResolvedValue({ results: [historySession], count: 1 });
    mocks.getEvents.mockResolvedValue({
      results: [
        event(1, "USER_MESSAGE", { content: "历史问题", remote_type: "user/message", remote_seq: 1 }),
        event(2, "OUTPUT", { content: "你好，世界" }),
      ],
      count: 2,
      latest_seq: 2,
      session: historySession,
    });
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");

    await act(async () => {
      document
        .querySelector('[aria-label="aiAssistant.launch_history"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForText("aiAssistant.launch_history_hint");
    expect(document.body.textContent).toContain("/lab/projects/project-1");
    expect(mocks.listSessions).toHaveBeenCalledWith("lab", { sessionIds: ["session-2"] });

    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("新材料研究"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForText("历史问题");
    await waitForText("你好，世界");
    expect(store.threadId).toBe("session-2");
  });

  it("restores the user prompt while an active run resumes after refresh", async () => {
    const activeSession = { ...session, session_id: "session-active", status: "STREAMING" };
    mocks.getSession.mockResolvedValue(activeSession);
    mocks.getEvents.mockResolvedValue({
      results: [event(1, "USER_MESSAGE", { content: "刷新后的问题", remote_type: "user/message", remote_seq: 1 })],
      count: 1,
      latest_seq: 1,
      session: activeSession,
    });
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.setThreadId("lab", "session-active");
    store.open();
    renderPanel(store);

    await waitForText("刷新后的问题");
    expect(mocks.getEvents).toHaveBeenCalledWith("lab", "run-1", 0);
  });

  it("preserves repeated identical prompts in one history session", async () => {
    const repeatedSession = { ...session, session_id: "session-repeated", status: "READY" };
    mocks.getSession.mockResolvedValue(repeatedSession);
    mocks.getEvents.mockResolvedValue({
      results: [
        event(1, "USER_MESSAGE", { content: "重复提问", remote_type: "user/message", remote_seq: 1 }),
        event(2, "OUTPUT", { content: "第一次回答" }),
        event(3, "USER_MESSAGE", { content: "重复提问", remote_type: "user/message", remote_seq: 3 }),
        event(4, "OUTPUT", { content: "第二次回答" }),
      ],
      count: 4,
      latest_seq: 4,
      session: repeatedSession,
    });
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.setThreadId("lab", "session-repeated");
    store.open();
    renderPanel(store);

    await waitForText("第二次回答");
    expect(document.body.textContent?.match(/重复提问/g)).toHaveLength(2);
  });

  it("navigates before restoring a history session from another target", async () => {
    globalThis.sessionStorage.setItem(
      "PLANE_AGENT_DOCK_LAUNCH_HISTORY_lab:anonymous",
      JSON.stringify({ launchId: "launch-1", sessionIds: ["session-cross"] })
    );
    const crossSession = {
      ...session,
      session_id: "session-cross",
      target_key: "workspace:ws",
      target_metadata: {
        workspace: { id: "ws", slug: "lab", name: "Lab" },
        target: { type: "WORKSPACE", id: "ws", title: "Lab", hierarchy: [] },
        page: {
          route: "/lab/research/chains/chain-1",
          page_kind: "research_chain",
          focus_id: "chain-1",
          focus_title: "研究链",
          hash: "hash",
          generated_at: "2026-11-04T11:00:00Z",
        },
      },
    };
    mocks.listSessions.mockResolvedValue({ results: [crossSession], count: 1 });
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");

    await act(async () => {
      document
        .querySelector('[aria-label="aiAssistant.launch_history"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForText("研究链");
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("研究链"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(routerPush).toHaveBeenCalledWith("/lab/research/chains/chain-1");
    expect(store.threadId).not.toBe("session-cross");
  });

  it("shows tool execution directly in the conversation timeline", async () => {
    mocks.streamEvents.mockImplementation((_workspace: string, _run: string, _cursor: number, signal: AbortSignal) =>
      Promise.resolve(
        sseResponse(
          [
            { type: "run.started", seq: 3 },
            { type: "context.bound", seq: 4, payload: { context_version: 1 } },
            { type: "run.progress", seq: 5, payload: { phase: "thinking" } },
            {
              type: "tool.started",
              seq: 6,
              payload: { name: "plane_get_context", tool_call_id: "call-1" },
            },
            {
              type: "tool.completed",
              seq: 7,
              payload: {
                name: "plane_get_context",
                tool_call_id: "call-1",
                status: "completed",
                arguments: { target: "project-1" },
                result: "context read",
              },
            },
            { type: "output.delta", seq: 8, payload: { content: "你好，世界" } },
            { type: "run.completed", seq: 9 },
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
    await waitForText("你好，世界");
    const question = [...document.querySelectorAll("div")].find((node) => node.textContent === "介绍这个项目");
    const answer = [...document.querySelectorAll("p")].find((node) => node.textContent === "你好，世界");
    const timeline = document.querySelector('[aria-label="aiAssistant.runtime_inline"]');
    expect(question?.compareDocumentPosition(timeline as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(timeline?.compareDocumentPosition(answer as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.body.textContent).toContain("plane_get_context");
    expect(document.body.textContent).toContain("runtime_context_bound");
    expect(document.body.textContent).toContain("runtime_thinking");
    expect(document.body.textContent).toContain("runtime_status_completed");
    expect(document.body.textContent).toContain("project-1");
    expect(document.body.textContent).toContain("context read");

    expect(timeline?.classList.contains("ml-7")).toBe(true);
    expect(timeline?.classList.contains("pl-3")).toBe(true);
    expect(timeline?.classList.contains("ml-auto")).toBe(false);
    expect(timeline?.classList.contains("max-w-[85%]")).toBe(false);

    const timelineMetadata = timeline?.firstElementChild;
    const latestEventTime = timelineMetadata?.querySelector("time");
    const toolStatus = [...timeline.querySelectorAll("details summary span")].at(-1);
    expect(timelineMetadata?.classList.contains("text-10")).toBe(true);
    expect(latestEventTime?.getAttribute("datetime")).toBe("2026-11-02T00:00:00Z");
    expect(latestEventTime?.className).toContain("ml-auto");
    expect(latestEventTime?.className).toContain("whitespace-nowrap");
    expect(latestEventTime?.className).toContain("tabular-nums");
    expect(toolStatus?.className).toContain("whitespace-nowrap");
  });

  it("keeps a completed replay answer below its runtime timeline", async () => {
    mocks.getEvents.mockResolvedValue({
      results: [
        event(1, "USER_MESSAGE", { content: "历史问题", remote_type: "user/message", remote_seq: 1 }),
        event(2, "TOOL_CALL", {
          remote_seq: 2,
          remote_type: "tool/result",
          name: "plane_get_context",
          tool_call_id: "history-call",
          status: "COMPLETED",
        }),
        event(3, "OUTPUT", { remote_seq: 3, remote_type: "assistant.snapshot", content: "已保存回答", final: true }),
      ],
      count: 3,
      latest_seq: 3,
      session,
    });
    window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab", "session-1");
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);

    await waitForText("已保存回答");
    const question = [...document.querySelectorAll("div")].find((node) => node.textContent === "历史问题");
    const answer = [...document.querySelectorAll("p")].find((node) => node.textContent === "已保存回答");
    const timeline = document.querySelector('[aria-label="aiAssistant.runtime_inline"]');
    expect(question?.compareDocumentPosition(timeline as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(timeline?.compareDocumentPosition(answer as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not reuse the previous run while a new question connects", async () => {
    mocks.sendMessage
      .mockReset()
      .mockResolvedValueOnce({ ...session, run_id: "run-1", status: "STREAMING", run_start_cursor: 2 })
      .mockResolvedValueOnce({ ...session, run_id: "run-2", status: "STREAMING", run_start_cursor: 10 });
    mocks.streamEvents
      .mockReset()
      .mockImplementation((_workspace: string, runId: string, _cursor: number, signal: AbortSignal) =>
        Promise.resolve(
          runId === "run-1"
            ? sseResponse(
                [
                  {
                    type: "tool.completed",
                    seq: 3,
                    payload: { name: "plane_get_context", tool_call_id: "call-old", status: "completed" },
                  },
                  { type: "output.delta", seq: 4, payload: { content: "第一轮回答" } },
                  { type: "run.completed", seq: 5 },
                ],
                signal,
                "run-1"
              )
            : sseResponse([], signal, "run-2")
        )
      );
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");

    typeAndSend("第一轮");
    await waitForText("第一轮回答");
    typeAndSend("第二轮");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    const conversationText = document.body.textContent ?? "";
    expect(conversationText).toContain("第二轮");
    expect(conversationText).not.toContain("plane_get_context");
    expect(conversationText).not.toContain("aiAssistant.runtime_elapsed");
    expect(conversationText).not.toContain("aiAssistant.runtime_latest_event");
    expect(conversationText.indexOf("第一轮回答")).toBeLessThan(conversationText.indexOf("第二轮"));
  });

  it("only listens to page selection while the cloud dock is open", async () => {
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");
    expect(addSpy).toHaveBeenCalledWith("selectionchange", expect.any(Function));

    await act(async () => store.close());

    expect(removeSpy).toHaveBeenCalledWith("selectionchange", expect.any(Function));
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("defers page context changes while a run is active", async () => {
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
    const resolveCountBeforeRouteChange = mocks.resolveContext.mock.calls.length;

    typeAndSend();
    await waitForText("处理中");
    currentPath = "/lab/research/chains/chain-1";
    renderPanel(store);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(mocks.resolveContext.mock.calls.length).toBe(resolveCountBeforeRouteChange);
    expect(document.body.textContent).toContain("处理中");
    expect(document.body.textContent).toContain("介绍这个项目");
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
    const closedPanel = document.querySelector('[data-testid="assistant-panel"]') as HTMLElement;
    expect(closedPanel.classList.contains("hidden")).toBe(true);
    expect(store.isOpen).toBe(false);
  });

  it("supports keyboard resizing for the docked agent separator", async () => {
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
    store.setWidth(420);
    renderPanel(store);
    await act(async () => undefined);

    const separator = document.querySelector('[aria-label="aiAssistant.resize"]') as HTMLElement;
    expect(separator.getAttribute("aria-valuemin")).toBe("320");
    expect(separator.getAttribute("aria-valuemax")).toBe("560");
    expect(separator.getAttribute("aria-valuenow")).toBe("420");
    await act(async () => {
      separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(store.width).toBe(436);
    await act(async () => {
      separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(store.width).toBe(420);
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
    const panel = document.querySelector('[data-testid="assistant-panel"]');
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
