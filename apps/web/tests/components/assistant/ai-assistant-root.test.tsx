// @vitest-environment jsdom
/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStatus: vi.fn(), mutateStatus: vi.fn() }));

vi.mock("@/services/assistant", () => ({
  AssistantService: class {
    getStatus = mocks.getStatus;
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "lab" }),
}));

vi.mock("swr", () => ({
  default: (key: string, fetcher: () => unknown) => {
    void key;
    void fetcher;
    return { data: mocks.getStatus(), error: undefined, mutate: mocks.mutateStatus };
  },
  useSWR: (key: string, fetcher: () => unknown) => {
    void key;
    void fetcher;
    return { data: mocks.getStatus(), error: undefined, mutate: mocks.mutateStatus };
  },
}));

vi.mock("@plane/i18n", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: { id: currentUserId } }),
}));

let currentUserId = "user-a";

vi.mock("@/components/assistant/ai-assistant-panel", () => ({
  AIAssistantPanel: () => <div data-testid="assistant-panel" />,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Create the isolated store context used by this test file. */
function createStoreContext(store: unknown) {
  return { aiAssistant: store } as never;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  currentUserId = "user-a";
  mocks.getStatus.mockReturnValue({ enabled: true, ready: true, state: "ready" });
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === "(min-width: 1024px)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

it("keeps a full-height shell and shows setup entry when Synlora is not configured", { timeout: 20000 }, async () => {
  mocks.getStatus.mockResolvedValue({
    enabled: false,
    ready: false,
    credential_mode: "PERSONAL",
    state: "personal_credential_required",
  });
  const { AIAssistantRoot } = await import("@/components/assistant/ai-assistant-root");
  const { AIAssistantStore } = await import("@/store/ai-assistant");
  const { StoreContext } = await import("@/lib/store-context");
  const store = new AIAssistantStore();
  const contextValue = createStoreContext(store);
  store.hydrate("lab");

  act(() => {
    root.render(
      <StoreContext.Provider value={contextValue}>
        <AIAssistantRoot>
          <main data-testid="unique-route-page">project page</main>
        </AIAssistantRoot>
      </StoreContext.Provider>
    );
  });
  await act(async () => undefined);

  const shell = container.firstElementChild;
  expect(shell?.classList.contains("size-full")).toBe(true);
  expect(shell?.classList.contains("min-h-0")).toBe(true);
  const workspace = shell?.querySelector("[data-right-dock-workspace]");
  expect(workspace?.classList.contains("min-h-0")).toBe(true);
  expect(workspace?.children).toHaveLength(1);
  expect(container.querySelectorAll('[data-testid="unique-route-page"]')).toHaveLength(1);
  expect(container.querySelector('[aria-label="aiAssistant.open"]')).not.toBeNull();
  expect(container.querySelector("[data-right-dock-rail]")).toBeNull();
  expect(container.textContent).toContain("project page");
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

it("keeps the dock shell and page outlet alive across route content changes", { timeout: 20000 }, async () => {
  mocks.getStatus.mockReturnValue({ enabled: true, ready: true });
  const { AIAssistantRoot } = await import("@/components/assistant/ai-assistant-root");
  const { AIAssistantStore } = await import("@/store/ai-assistant");
  const { StoreContext } = await import("@/lib/store-context");
  const store = new AIAssistantStore();
  const contextValue = createStoreContext(store);
  store.hydrate("lab");
  store.open();
  store.setDockMode("docked");

  const renderRoute = (label: string) => {
    act(() => {
      root.render(
        <StoreContext.Provider value={contextValue}>
          <AIAssistantRoot>
            <main data-testid="route-page">{label}</main>
          </AIAssistantRoot>
        </StoreContext.Provider>
      );
    });
  };

  renderRoute("home");
  await act(async () => undefined);
  expect(store.status?.state).toBe("ready");
  expect(container.querySelector('[data-testid="assistant-panel"]')).not.toBeNull();
  const shell = container.firstElementChild;
  renderRoute("research-chain");

  expect(container.firstElementChild).toBe(shell);
  expect(container.querySelector('[data-testid="assistant-panel"]')).not.toBeNull();
  expect(container.querySelectorAll('[data-testid="route-page"]')).toHaveLength(1);
  expect(container.textContent).toContain("research-chain");
});

it("keeps a floating agent above the page without a persistent rail", async () => {
  mocks.getStatus.mockReturnValue({ enabled: true, ready: true, state: "ready" });
  const { AIAssistantRoot } = await import("@/components/assistant/ai-assistant-root");
  const { AIAssistantStore } = await import("@/store/ai-assistant");
  const { StoreContext } = await import("@/lib/store-context");
  const store = new AIAssistantStore();
  const contextValue = createStoreContext(store);
  store.hydrate("lab");
  store.setDockMode("floating");
  store.open();

  await act(async () =>
    root.render(
      <StoreContext.Provider value={contextValue}>
        <AIAssistantRoot>
          <main data-testid="floating-route-page">floating page</main>
        </AIAssistantRoot>
      </StoreContext.Provider>
    )
  );

  expect(container.querySelectorAll('[data-testid="floating-route-page"]')).toHaveLength(1);
  expect(container.querySelector('[data-testid="assistant-panel"]')).not.toBeNull();
  expect(container.querySelector("[data-right-dock-rail]")).toBeNull();
});

it("renders an expanded pinned agent as a full-width floating layer", async () => {
  mocks.getStatus.mockReturnValue({ enabled: true, ready: true, state: "ready" });
  const { AIAssistantRoot } = await import("@/components/assistant/ai-assistant-root");
  const { AIAssistantStore } = await import("@/store/ai-assistant");
  const { StoreContext } = await import("@/lib/store-context");
  const store = new AIAssistantStore();
  const contextValue = createStoreContext(store);
  store.hydrate("lab");
  store.open();
  store.setDockMode("docked");
  store.toggleExpanded(true);

  await act(async () =>
    root.render(
      <StoreContext.Provider value={contextValue}>
        <AIAssistantRoot>
          <main>expanded page</main>
        </AIAssistantRoot>
      </StoreContext.Provider>
    )
  );

  const agentSlot = container.querySelector("[data-right-dock-agent]") as HTMLElement;
  expect(agentSlot.classList.contains("fixed")).toBe(true);
  expect(agentSlot.style.width).toBe("100%");
  expect(agentSlot.classList.contains("flex")).toBe(true);
});

it("collapses an expanded agent when a detail dock needs side-by-side space", async () => {
  mocks.getStatus.mockReturnValue({ enabled: true, ready: true, state: "ready" });
  const { AIAssistantRoot } = await import("@/components/assistant/ai-assistant-root");
  const { RightDockPortal } = await import("@/components/right-dock");
  const { AIAssistantStore } = await import("@/store/ai-assistant");
  const { StoreContext } = await import("@/lib/store-context");
  const store = new AIAssistantStore();
  const contextValue = createStoreContext(store);
  store.hydrate("lab");
  store.open();
  store.setDockMode("docked");
  store.toggleExpanded(true);

  await act(async () =>
    root.render(
      // eslint-disable-next-line react/jsx/no-constructed-context-values -- test-only provider value
      <StoreContext.Provider value={contextValue}>
        <AIAssistantRoot>
          <main>detail page</main>
          <RightDockPortal id="issue-expand" title="任务详情" onClose={() => undefined}>
            <div>任务详情</div>
          </RightDockPortal>
        </AIAssistantRoot>
      </StoreContext.Provider>
    )
  );

  await act(async () => undefined);

  expect(store.expanded).toBe(false);
  const agentSlot = container.querySelector("[data-right-dock-agent]") as HTMLElement;
  expect(agentSlot.classList.contains("flex")).toBe(true);
  expect(agentSlot.classList.contains("fixed")).toBe(false);
});

it("hydrates the assistant thread with the current user scope", { timeout: 20000 }, async () => {
  window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab:user-a", "thread-a");
  window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab:user-b", "thread-b");
  const { AIAssistantRoot } = await import("@/components/assistant/ai-assistant-root");
  const { AIAssistantStore } = await import("@/store/ai-assistant");
  const { StoreContext } = await import("@/lib/store-context");
  const store = new AIAssistantStore();
  const contextValue = createStoreContext(store);

  act(() => {
    root.render(
      <StoreContext.Provider value={contextValue}>
        <AIAssistantRoot>
          <main>user scope</main>
        </AIAssistantRoot>
      </StoreContext.Provider>
    );
  });
  await act(async () => undefined);

  expect(store.threadId).toBe("thread-a");
  expect(window.localStorage.getItem("PLANE_AI_ASSISTANT_THREAD_lab:user-b")).toBe("thread-b");
});

it("clears the browser launch batch when the user scope changes", async () => {
  window.sessionStorage.setItem(
    "PLANE_AGENT_DOCK_LAUNCH_HISTORY_lab:user-a",
    JSON.stringify({ launchId: "launch-a", sessionIds: ["session-a"] })
  );
  window.sessionStorage.setItem(
    "PLANE_AGENT_DOCK_LAUNCH_HISTORY_lab:user-b",
    JSON.stringify({ launchId: "launch-b", sessionIds: ["session-b"] })
  );
  const { AIAssistantRoot } = await import("@/components/assistant/ai-assistant-root");
  const { AIAssistantStore } = await import("@/store/ai-assistant");
  const { StoreContext } = await import("@/lib/store-context");
  const store = new AIAssistantStore();
  const contextValue = createStoreContext(store);
  const render = () =>
    act(async () =>
      root.render(
        <StoreContext.Provider value={contextValue}>
          <AIAssistantRoot>
            <main>user scope</main>
          </AIAssistantRoot>
        </StoreContext.Provider>
      )
    );

  await render();
  currentUserId = "user-b";
  await render();

  expect(window.sessionStorage.getItem("PLANE_AGENT_DOCK_LAUNCH_HISTORY_lab:user-b")).toBeNull();
  expect(window.sessionStorage.getItem("PLANE_AGENT_DOCK_LAUNCH_HISTORY_lab:user-a")).toBeNull();
});
