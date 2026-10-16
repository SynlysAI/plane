// @vitest-environment jsdom
/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { describe, expect, it, beforeEach } from "vitest";
// assistant
import { AIAssistantStore } from "@/store/ai-assistant";

describe("AIAssistantStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("toggles panel visibility", () => {
    const store = new AIAssistantStore();
    expect(store.isOpen).toBe(false);
    store.open();
    expect(store.isOpen).toBe(true);
    store.close();
    expect(store.isOpen).toBe(false);
    store.toggle();
    expect(store.isOpen).toBe(true);
    store.toggle(false);
    expect(store.isOpen).toBe(false);
  });

  it("persists a thread id per workspace and hydrates once per switch", () => {
    const store = new AIAssistantStore();
    store.hydrate("lab-a");
    store.setThreadId("lab-a", "thread-1");
    expect(window.localStorage.getItem("PLANE_AI_ASSISTANT_THREAD_lab-a")).toBe("thread-1");

    // re-hydration of the same workspace keeps the in-memory value
    store.hydrate("lab-a");
    expect(store.threadId).toBe("thread-1");

    // switching workspaces hydrates that workspace's own thread
    window.localStorage.setItem("PLANE_AI_ASSISTANT_THREAD_lab-b", "thread-2");
    store.hydrate("lab-b");
    expect(store.threadId).toBe("thread-2");
  });

  it("clears the thread id and storage entry", () => {
    const store = new AIAssistantStore();
    store.hydrate("lab-a");
    store.setThreadId("lab-a", "thread-1");
    store.clearThreadId("lab-a");
    expect(store.threadId).toBeNull();
    expect(window.localStorage.getItem("PLANE_AI_ASSISTANT_THREAD_lab-a")).toBeNull();
  });
});
