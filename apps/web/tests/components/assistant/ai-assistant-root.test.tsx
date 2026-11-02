// @vitest-environment jsdom
/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStatus: vi.fn() }));

vi.mock("@/services/assistant", () => ({
  AssistantService: class {
    getStatus = mocks.getStatus;
  },
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "lab" }),
}));

vi.mock("@plane/i18n", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/assistant/ai-assistant-panel", () => ({
  AIAssistantPanel: () => <div data-testid="assistant-panel" />,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  mocks.getStatus.mockResolvedValue({ enabled: true, ready: true });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.localStorage.clear();
});

it("keeps the dock shell and page outlet alive across route content changes", { timeout: 20000 }, async () => {
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
  expect(container.querySelector('[data-testid="assistant-panel"]')).not.toBeNull();
  const shell = container.firstElementChild;
  renderRoute("research-chain");

  expect(container.firstElementChild).toBe(shell);
  expect(container.querySelector('[data-testid="assistant-panel"]')).not.toBeNull();
  expect(container.textContent).toContain("research-chain");
});
