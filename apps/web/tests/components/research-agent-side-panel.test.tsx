// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      if (typeof value !== "string") return key;
      return value.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ""));
    },
  }),
}));
vi.mock("@/components/research/agent/research-agent-plugin", () => ({
  ResearchAgentPlugin: ({ chainNodeId, variant }: { chainNodeId: string; variant?: string }) => (
    <div data-testid="agent-plugin" data-variant={variant}>
      {chainNodeId}
    </div>
  ),
}));

const { ResearchAgentSidePanel } = await import("@/components/research/agent/research-agent-side-panel");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("opens as a right drawer that inherits the current node context", async () => {
  await act(async () =>
    root.render(<ResearchAgentSidePanel workspaceSlug="lab" chainNodeId="node-1" onClose={() => undefined} />)
  );
  const dialog = container.querySelector('[role="dialog"][aria-modal="true"]');
  expect(dialog).not.toBeNull();
  const plugin = container.querySelector('[data-testid="agent-plugin"]');
  expect(plugin?.textContent).toBe("node-1");
  expect(plugin?.getAttribute("data-variant")).toBe("panel");
  expect(dialog?.className).toContain("right-0");
  expect(dialog?.className).toContain("max-w-[400px]");
});

it("closes from the close button", async () => {
  const onClose = vi.fn();
  await act(async () =>
    root.render(<ResearchAgentSidePanel workspaceSlug="lab" chainNodeId="node-1" onClose={onClose} />)
  );
  const closeButton = container.querySelector('button[aria-label="关闭抽屉"]');
  expect(closeButton).not.toBeNull();
  await act(async () => closeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(onClose).toHaveBeenCalled();
});
