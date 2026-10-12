// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  research: {
    isEnabled: true,
    isIaV2Enabled: true,
  },
}));

vi.mock("@/components/sidebar/sidebar-wrapper", () => ({
  SidebarWrapper: ({ children }: { children: React.ReactNode }) => <aside>{children}</aside>,
}));
vi.mock("@/components/workspace/sidebar/favorites/favorites-menu", () => ({
  SidebarFavoritesMenu: () => <div>favorites-menu</div>,
}));
vi.mock("@/components/workspace/sidebar/projects-list", () => ({
  SidebarProjectsList: () => <div>legacy-projects-list</div>,
}));
vi.mock("@/components/workspace/sidebar/quick-actions", () => ({
  SidebarQuickActions: () => <div>quick-actions</div>,
}));
vi.mock("@/components/workspace/sidebar/sidebar-menu-items", () => ({
  SidebarMenuItems: () => <nav>home-navigation</nav>,
}));
vi.mock("@/components/research/navigation/research-sidebar-items", () => ({
  ResearchSidebarItems: () => <div>research-navigation</div>,
}));
vi.mock("@/hooks/store/use-favorite", () => ({
  useFavorite: () => ({ groupedFavorites: {} }),
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({ allowPermissions: () => true }),
}));

const { AppSidebar } = await import("../../app/(all)/[workspaceSlug]/(projects)/sidebar");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.research.isEnabled = true;
  mocks.research.isIaV2Enabled = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("replaces the legacy projects list with scoped trees when IA v2 is enabled", async () => {
  await act(async () => root.render(<AppSidebar />));

  expect(container.textContent).toContain("home-navigation");
  expect(container.textContent).toContain("research-navigation");
  expect(container.textContent).not.toContain("legacy-projects-list");
});

it("restores the legacy projects list when IA v2 is disabled", async () => {
  mocks.research.isIaV2Enabled = false;
  await act(async () => root.render(<AppSidebar />));

  expect(container.textContent).toContain("research-navigation");
  expect(container.textContent).toContain("legacy-projects-list");
});
