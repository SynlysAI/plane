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
  useUser: () => ({ data: { id: "user-a" } }),
}));

vi.mock("@/components/assistant/ai-assistant-panel", () => ({
  AIAssistantPanel: () => <div data-testid="assistant-panel" />,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.getStatus.mockReturnValue({ enabled: true, ready: true, state: "ready" });
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
  store.hydrate("lab");

  act(() => {
    root.render(
      // eslint-disable-next-line react/jsx-no-constructed-context-values -- test-only provider value
      <StoreContext.Provider value={{ aiAssistant: store } as never}>
        <AIAssistantRoot>
          <main>project page</main>
        </AIAssistantRoot>
      </StoreContext.Provider>
    );
  });
  await act(async () => undefined);

  const shell = container.firstElementChild;
  expect(shell?.classList.contains("size-full")).toBe(true);
  expect(shell?.classList.contains("min-h-0")).toBe(true);
  expect(shell?.firstElementChild?.classList.contains("size-full")).toBe(true);
  expect(shell?.firstElementChild?.classList.contains("min-h-0")).toBe(true);
  expect(container.querySelector('[aria-label="aiAssistant.open"]')).not.toBeNull();
  expect(container.textContent).toContain("project page");
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
});

it("keeps the dock shell and page outlet alive across route content changes", { timeout: 20000 }, async () => {
  mocks.getStatus.mockReturnValue({ enabled: true, ready: true });
  const { AIAssistantRoot } = await import("@/components/assistant/ai-assistant-root");
  const { AIAssistantStore } = await import("@/store/ai-assistant");
  const { StoreContext } = await import("@/lib/store-context");
  const store = new AIAssistantStore();
  store.hydrate("lab");
  store.open();
  store.setDockMode("docked");

  const renderRoute = (label: string) => {
    act(() => {
      root.render(
        // eslint-disable-next-line react/jsx-no-constructed-context-values -- test-only provider value
        <StoreContext.Provider value={{ aiAssistant: store } as never}>
          <AIAssistantRoot>
            <main>{label}</main>
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
  expect(container.textContent).toContain("research-chain");
});

it("hydrates the assistant thread with the current user scope", { timeout: 20000 }, async () => {
  window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab:user-a", "thread-a");
  window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab:user-b", "thread-b");
  const { AIAssistantRoot } = await import("@/components/assistant/ai-assistant-root");
  const { AIAssistantStore } = await import("@/store/ai-assistant");
  const { StoreContext } = await import("@/lib/store-context");
  const store = new AIAssistantStore();

  act(() => {
    root.render(
      // eslint-disable-next-line react/jsx-no-constructed-context-values -- test-only provider value
      <StoreContext.Provider value={{ aiAssistant: store } as never}>
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
