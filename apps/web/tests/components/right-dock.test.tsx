// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
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
        <RightDockShell
          agentOpen
          agentDocked
          agentWidth={420}
          launcherVisible={false}
          onOpenAgent={() => undefined}
          agentPanel={<aside data-testid="agent" />}
        >
          <main data-testid="main">workspace page</main>
          <RightDockPortal
            id="task-1"
            title="科研采购审批-丙二醇甲醚醋酸酯等试剂耗材-80367.3元"
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
  const workspace = document.querySelector("[data-right-dock-workspace]") as HTMLElement;
  const detail = document.querySelector('[data-right-dock-detail="task-1"]');
  const agent = document.querySelector('[data-testid="agent"]');
  const detailBody = document.querySelector("#plane-right-detail-dock-body");
  expect(main).not.toBeNull();
  expect(detail).not.toBeNull();
  expect(agent).not.toBeNull();
  expect(document.querySelectorAll("[data-right-dock-workspace]")).toHaveLength(1);
  expect(document.querySelector("[data-right-dock-rail]")).toBeNull();
  expect(detail?.classList.contains("fixed")).toBe(false);
  expect(detail?.classList.contains("hidden")).toBe(false);
  expect(detail?.classList.contains("flex")).toBe(true);
  expect(detail?.classList.contains("relative")).toBe(true);
  expect(detail?.classList.contains("isolate")).toBe(true);
  expect(detailBody?.classList.contains("relative")).toBe(true);
  expect(workspace.style.flexBasis).toBe("min(320px, 100%)");
  expect(workspace.style.flexGrow).toBe("1");
  expect(workspace.style.flexShrink).toBe("0");
  expect(detail?.style.flexBasis).toBe("min(34%, 520px)");
  expect(detail?.style.minWidth).toBe("min(320px, 100%)");
  const agentSlot = document.querySelector("[data-right-dock-agent]");
  expect(agentSlot?.style.flexBasis).toBe("420px");
  expect(agentSlot?.style.minWidth).toBe("min(320px, 100%)");
  expect(Boolean(main?.compareDocumentPosition(detail) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  expect(document.querySelector('[data-testid="detail-body"]')?.textContent).toBe("任务详情");
  expect(document.querySelector('[data-testid="focus"]')?.textContent).toBe("RESEARCH_TASK:task-1");
  const detailHeading = detail?.querySelector("p");
  expect(detailHeading?.className).toContain("break-words");
  expect(detailHeading?.className).not.toContain("truncate");
});

it("uses a wide detail column and keeps the agent rail available when the agent is not docked", async () => {
  const { RightDockPortal, RightDockProvider, RightDockShell } = await import("@/components/right-dock");
  const onOpenAgent = vi.fn();
  await act(async () =>
    root.render(
      <RightDockProvider>
        <RightDockShell agentOpen={false} onOpenAgent={onOpenAgent} agentPanel={<aside data-testid="agent" />}>
          <main>workspace page</main>
          <RightDockPortal id="issue-wide" title="行政任务" onClose={() => undefined}>
            <div>任务详情</div>
          </RightDockPortal>
        </RightDockShell>
      </RightDockProvider>
    )
  );

  const detail = document.querySelector('[data-right-dock-detail="issue-wide"]') as HTMLElement;
  const railButton = document.querySelector<HTMLButtonElement>("[data-right-dock-rail] button");
  expect(detail.style.flexBasis).toBe("min(45%, 720px)");
  expect(document.querySelector("[data-right-dock-rail]")).not.toBeNull();
  expect(railButton).not.toBeNull();
  await act(async () => railButton?.click());
  expect(onOpenAgent).toHaveBeenCalledOnce();
});

it("contains legacy detail mounts inside the fallback panel", async () => {
  const { RightDockPortal } = await import("@/components/right-dock");
  await act(async () =>
    root.render(
      <RightDockPortal id="legacy-detail" title="任务详情" onClose={() => undefined}>
        <div data-testid="legacy-detail-body">任务详情</div>
      </RightDockPortal>
    )
  );

  const fallback = document.querySelector("aside");
  expect(fallback?.classList.contains("fixed")).toBe(true);
  expect(fallback?.classList.contains("isolate")).toBe(true);
  expect(fallback?.classList.contains("min-w-0")).toBe(true);
  expect(fallback?.classList.contains("overflow-hidden")).toBe(true);
  expect(document.querySelector('[data-testid="legacy-detail-body"]')?.textContent).toBe("任务详情");
});

it("escape closes the active detail before the persistent agent slot", async () => {
  const { RightDockPortal, RightDockProvider, RightDockShell } = await import("@/components/right-dock");
  const closeDetail = vi.fn();
  await act(async () =>
    root.render(
      <RightDockProvider>
        <RightDockShell agentOpen agentDocked onOpenAgent={() => undefined} agentPanel={<aside data-testid="agent" />}>
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

it("shows the floating launcher instead of a persistent rail when no dock is active", async () => {
  const { RightDockProvider, RightDockShell } = await import("@/components/right-dock");
  await act(async () =>
    root.render(
      <RightDockProvider>
        <RightDockShell onOpenAgent={() => undefined} agentPanel={<aside data-testid="agent" />}>
          <div>workspace page</div>
        </RightDockShell>
      </RightDockProvider>
    )
  );

  expect(document.querySelector("[data-right-dock-agent-launcher]")).not.toBeNull();
  expect(document.querySelector("[data-right-dock-rail]")).toBeNull();
  const hiddenAgentSlot = document.querySelector("[data-right-dock-agent]") as HTMLElement;
  expect(hiddenAgentSlot.classList.contains("hidden")).toBe(true);
  expect(hiddenAgentSlot.getAttribute("aria-hidden")).toBe("true");
});

it("does not show a rail for a floating agent", async () => {
  const { RightDockProvider, RightDockShell } = await import("@/components/right-dock");
  await act(async () =>
    root.render(
      <RightDockProvider>
        <RightDockShell agentOpen onOpenAgent={() => undefined} agentPanel={<aside data-testid="agent" />}>
          <div>workspace page</div>
        </RightDockShell>
      </RightDockProvider>
    )
  );

  expect(document.querySelector('[data-testid="agent"]')).not.toBeNull();
  expect(document.querySelector("[data-right-dock-rail]")).toBeNull();
});

it("does not show a rail behind an open floating agent when a detail is active", async () => {
  const { RightDockPortal, RightDockProvider, RightDockShell } = await import("@/components/right-dock");
  await act(async () =>
    root.render(
      <RightDockProvider>
        <RightDockShell agentOpen agentDocked={false} onOpenAgent={() => undefined} agentPanel={<aside />}>
          <main>page</main>
          <RightDockPortal id="issue-floating" title="任务详情" onClose={() => undefined}>
            <div>任务详情</div>
          </RightDockPortal>
        </RightDockShell>
      </RightDockProvider>
    )
  );

  expect(document.querySelector('[data-right-dock-detail="issue-floating"]')).not.toBeNull();
  expect(document.querySelector("[data-right-dock-agent]")?.classList.contains("fixed")).toBe(true);
  expect(document.querySelector("[data-right-dock-rail]")).toBeNull();
});

it("keeps the agent component mounted while switching between docked and floating modes", async () => {
  const { RightDockProvider, RightDockShell } = await import("@/components/right-dock");
  let mounts = 0;
  function AgentProbe() {
    React.useEffect(() => {
      mounts += 1;
    }, []);
    return <aside data-testid="persistent-agent">streaming state</aside>;
  }
  const agentPanel = <AgentProbe />;

  await act(async () =>
    root.render(
      <RightDockProvider>
        <RightDockShell agentOpen agentDocked onOpenAgent={() => undefined} agentPanel={agentPanel}>
          <main>workspace</main>
        </RightDockShell>
      </RightDockProvider>
    )
  );
  await act(async () =>
    root.render(
      <RightDockProvider>
        <RightDockShell agentOpen agentDocked={false} onOpenAgent={() => undefined} agentPanel={agentPanel}>
          <main>workspace</main>
        </RightDockShell>
      </RightDockProvider>
    )
  );

  expect(mounts).toBe(1);
  expect(document.querySelector('[data-testid="persistent-agent"]')?.textContent).toBe("streaming state");
});
