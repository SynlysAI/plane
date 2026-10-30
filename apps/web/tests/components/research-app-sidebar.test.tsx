// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ context: null as object | null, error: null as string | null, retry: vi.fn() }));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@/hooks/use-workspace-context", () => ({ useWorkspaceContext: () => mocks }));
vi.mock("@/components/sidebar/sidebar-wrapper", () => ({
  SidebarWrapper: ({ children, contentLayout }: { children: React.ReactNode; contentLayout: string }) => (
    <aside data-layout={contentLayout}>{children}</aside>
  ),
}));
vi.mock("@/components/workspace/sidebar/quick-actions", () => ({ SidebarQuickActions: () => null }));
vi.mock("@/components/workspace/sidebar/sidebar-menu-items", () => ({
  SidebarMenuItems: () => <nav>首页 审批中心</nav>,
}));
vi.mock("@/components/research/navigation/research-sidebar-items", () => ({
  ResearchSidebarItems: () => <div>行政项目</div>,
}));
const { AppSidebar } = await import("../../app/(all)/[workspaceSlug]/(projects)/sidebar");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  mocks.context = null;
  mocks.error = null;
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllMocks();
});
it("shows placeholders before configuration, then renders only the fixed layout", async () => {
  await act(async () => root.render(<AppSidebar />));
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(container.textContent).not.toContain("行政项目");
  mocks.context = { workspace_enabled: false, research_ia_v2: false };
  await act(async () => root.render(<AppSidebar />));
  expect(container.textContent).toContain("行政项目");
  expect(container.textContent).not.toContain("More");
  expect(container.querySelector("aside")?.dataset.layout).toBe("fill");
});
it("offers retry without falling back to old navigation", async () => {
  mocks.error = "generic";
  await act(async () => root.render(<AppSidebar />));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.querySelector("nav")).not.toBeNull();
  await act(async () => container.querySelector("button")?.click());
  expect(mocks.retry).toHaveBeenCalledOnce();
  expect(container.querySelector("nav")).not.toBeNull();
});
