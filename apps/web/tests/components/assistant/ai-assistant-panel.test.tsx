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
  getStatus: vi.fn(),
  createSession: vi.fn(),
  startChat: vi.fn(),
  cancelRun: vi.fn(),
  getRunResult: vi.fn(),
  getHistory: vi.fn(),
  streamRunEvents: vi.fn(),
}));

vi.mock("@/services/assistant", () => ({
  AssistantService: class {
    getStatus = mocks.getStatus;
    createSession = mocks.createSession;
    startChat = mocks.startChat;
    cancelRun = mocks.cancelRun;
    getRunResult = mocks.getRunResult;
    getHistory = mocks.getHistory;
    streamRunEvents = mocks.streamRunEvents;
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "lab" }),
  usePathname: () => "/lab/projects",
}));

vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ getProjectById: () => undefined }) }));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({ getWorkspaceBySlug: () => ({ name: "Lab", slug: "lab" }) }),
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({ useIssueDetail: () => ({ peekIssue: undefined }) }));
vi.mock("@plane/i18n", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { AIAssistantPanel } = await import("@/components/assistant/ai-assistant-panel");
const { AIAssistantStore } = await import("@/store/ai-assistant");
const { StoreContext } = await import("@/lib/store-context");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SSE_FRAMES = [
  'event: messages\ndata: {"payload":{"items":[{"stream_event":{"type":"message_delta","content":"你好"}}]}}\n\n',
  'event: messages\ndata: {"payload":{"items":[{"stream_event":{"type":"message_delta","content":"，世界"}}]}}\n\n',
  'event: end\ndata: {"payload":{"status":"completed"}}\n\n',
];

const MARKDOWN_TABLE = [
  "| Category | Capability |",
  "| :--- | ---: |",
  "| Search | **Full text** |",
  "| Analysis | `SQL` |",
].join("\n");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.querySelectorAll("[id^='plane-portal'], .fixed.inset-0").forEach((node) => node.remove());
  vi.clearAllMocks();
});

function renderPanel(store: InstanceType<typeof AIAssistantStore>) {
  const contextValue = { aiAssistant: store } as never;
  act(() => {
    root.render(
      // eslint-disable-next-line react/jsx-no-constructed-context-values -- test-only provider value
      <StoreContext.Provider value={contextValue}>
        <AIAssistantPanel workspaceSlug="lab" />
      </StoreContext.Provider>
    );
  });
}

function typeAndSend() {
  // the panel portals its content into a body-level container
  const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
  const sendButton = [...document.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "aiAssistant.send"
  ) as HTMLButtonElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, "介绍这个页面");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

describe("AIAssistantPanel", () => {
  beforeEach(() => {
    mocks.getStatus.mockResolvedValue({ enabled: true, ready: true });
    mocks.getHistory.mockReset();
    mocks.createSession.mockResolvedValue({ thread_id: "thread-1", title: "Plane/lab" });
    mocks.startChat.mockResolvedValue({
      request_id: "r-1",
      run_id: "run-1",
      status: "dispatched",
      message_id: 1,
      thread_id: "thread-1",
      queued: false,
    });
    mocks.streamRunEvents.mockImplementation(
      async (_slug: string, _runId: string, options: { onChunk: (c: string) => void }) => {
        for (const frame of SSE_FRAMES) options.onChunk(frame);
      }
    );
    window.localStorage.clear();
  });

  it("streams answer deltas into the message list and finalizes on end", async () => {
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);

    typeAndSend();
    await waitForText("你好，世界");
    // the user message is echoed
    expect(document.body.textContent).toContain("介绍这个页面");
    // thread persisted for the next visit
    expect(window.localStorage.getItem("PLANE_AI_ASSISTANT_THREAD_lab")).toBe("thread-1");
  });

  it("keeps history when reopening an existing thread", async () => {
    mocks.getHistory.mockResolvedValue([
      { role: "user", content: "之前的问题" },
      { role: "assistant", content: "之前的回答" },
    ]);
    window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab", "thread-9");
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);

    await waitForText("之前的回答");
  });

  it("renders tables and inline markdown in conversation history", async () => {
    mocks.getHistory.mockResolvedValue([{ role: "assistant", content: MARKDOWN_TABLE }]);
    window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab", "thread-9");
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);

    await waitForText("Full text");
    const table = document.querySelector(".answer-markdown table");
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll("th")).toHaveLength(2);
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(table?.querySelector("strong")?.textContent).toBe("Full text");
    expect(table?.querySelector("code")?.textContent).toBe("SQL");
    expect(table?.querySelectorAll("th")[1].style.textAlign).toBe("right");
    expect(table?.parentElement?.classList.contains("overflow-x-auto")).toBe(true);
  });

  it("renders a streamed table before and after the answer completes", async () => {
    let completeStream: (() => void) | undefined;
    mocks.streamRunEvents.mockImplementation(
      async (_slug: string, _runId: string, options: { onChunk: (chunk: string) => void }) => {
        for (const content of ["| Category | Capability |\n| :--- | ---: |\n", "| Search | **Full text** |\n"]) {
          const data = { payload: { items: [{ stream_event: { type: "message_delta", content } }] } };
          options.onChunk(`event: messages\ndata: ${JSON.stringify(data)}\n\n`);
        }
        await new Promise<void>((resolve) => {
          completeStream = resolve;
        });
        options.onChunk('event: end\ndata: {"payload":{"status":"completed"}}\n\n');
      }
    );
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);

    typeAndSend();
    await waitForText("Full text");
    expect(document.querySelector(".answer-markdown table strong")?.textContent).toBe("Full text");
    expect(document.querySelector('[aria-label="aiAssistant.stop"]')).not.toBeNull();

    await act(async () => completeStream?.());
    expect(document.querySelectorAll(".answer-markdown table")).toHaveLength(1);
    expect(document.querySelector('[aria-label="aiAssistant.stop"]')).toBeNull();
  });

  it("shows an inline error when the stream fails", async () => {
    mocks.streamRunEvents.mockRejectedValue(new Error("assistant_stream_http_502"));
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);

    typeAndSend();
    await waitForText("aiAssistant.error_generic");
  });
});
