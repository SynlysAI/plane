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
  createSession: vi.fn(),
  sendMessage: vi.fn(),
  getEvents: vi.fn(),
  cancelRun: vi.fn(),
}));

vi.mock("@/services/agent-dock", () => ({
  AgentDockService: class {
    resolveContext = mocks.resolveContext;
    listSessions = mocks.listSessions;
    getSession = mocks.getSession;
    createSession = mocks.createSession;
    sendMessage = mocks.sendMessage;
    getEvents = mocks.getEvents;
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
  mocks.createSession.mockReset().mockResolvedValue(session);
  mocks.sendMessage.mockReset().mockResolvedValue({ ...session, status: "STREAMING" });
  mocks.getEvents.mockReset().mockResolvedValue({
    results: [event(2, "OUTPUT", { content: "你好，世界" })],
    count: 1,
    latest_seq: 2,
    session,
  });
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
    expect(mocks.sendMessage).toHaveBeenCalledWith("lab", "session-1", "介绍这个项目");
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
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("新材料研究");

    typeAndSend();
    await waitForText("介绍这个项目");
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

  it("restores an existing dock session without leaking context bodies", async () => {
    window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab", "session-1");
    const store = new AIAssistantStore();
    store.hydrate("lab");
    store.open();
    renderPanel(store);
    await waitForText("你好，世界");
    expect(mocks.getSession).toHaveBeenCalledWith("lab", "session-1");
    expect(mocks.createSession).not.toHaveBeenCalled();
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
    await waitForText("aiAssistant.error_generic");
  });
});
