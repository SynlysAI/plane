// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === "(min-width: 1440px)",
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

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("renders detail and agent as sibling flow columns without a fixed overlay", async () => {
  const { RightDockPortal, RightDockProvider, RightDockShell, useRightDockState } =
    await import("@/components/right-dock");
  function FocusProbe() {
    const { focusRef } = useRightDockState();
    return <output data-testid="focus">{focusRef ? `${focusRef.type}:${focusRef.id}` : ""}</output>;
  }

  await act(async () =>
    root.render(
      <RightDockProvider>
        <RightDockShell agentOpen onOpenAgent={() => undefined} agentPanel={<aside data-testid="agent" />}>
          <main data-testid="main">workspace page</main>
          <RightDockPortal
            id="task-1"
            title="科研任务"
            focusRef={{ type: "RESEARCH_TASK", id: "task-1" }}
            onClose={() => undefined}
          >
            <section data-testid="detail-body">任务详情</section>
          </RightDockPortal>
          <FocusProbe />
        </RightDockShell>
      </RightDockProvider>
    )
  );

  const main = document.querySelector('[data-testid="main"]');
  const detail = document.querySelector('[data-right-dock-detail="task-1"]');
  const agent = document.querySelector('[data-testid="agent"]');
  expect(main).not.toBeNull();
  expect(detail).not.toBeNull();
  expect(agent).not.toBeNull();
  expect(detail?.classList.contains("fixed")).toBe(false);
  expect(Boolean(main?.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  expect(document.querySelector('[data-testid="detail-body"]')?.textContent).toBe("任务详情");
  expect(document.querySelector('[data-testid="focus"]')?.textContent).toBe("RESEARCH_TASK:task-1");
});

it("escape closes the active detail before the persistent agent slot", async () => {
  const { RightDockPortal, RightDockProvider, RightDockShell } = await import("@/components/right-dock");
  const closeDetail = vi.fn();
  await act(async () =>
    root.render(
      <RightDockProvider>
        <RightDockShell agentOpen onOpenAgent={() => undefined} agentPanel={<aside data-testid="agent" />}>
          <main>page</main>
          <RightDockPortal id="issue-1" title="任务详情" onClose={closeDetail}>
            <div>任务详情</div>
          </RightDockPortal>
        </RightDockShell>
      </RightDockProvider>
    )
  );

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  expect(closeDetail).toHaveBeenCalledOnce();
  expect(document.querySelector('[data-testid="agent"]')).not.toBeNull();
  expect(document.querySelector('[data-right-dock-detail="issue-1"]')).toBeNull();
});
