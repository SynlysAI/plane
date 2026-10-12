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

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/sidebar/sidebar-navigation", () => ({
  SidebarNavItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/workspace/sidebar/sidebar-item", () => ({
  SidebarItemBase: ({ item }: { item: { key: string; href: string; labelTranslationKey: string } }) => (
    <a href={item.href} data-key={item.key}>
      {item.labelTranslationKey}
    </a>
  ),
}));
vi.mock("@/hooks/store/use-app-theme", () => ({
  useAppTheme: () => ({ isExtendedSidebarOpened: false, toggleExtendedSidebar: vi.fn() }),
}));
vi.mock("@/hooks/use-local-storage", () => ({
  default: () => ({ storedValue: true, setValue: vi.fn() }),
}));
vi.mock("@/hooks/use-navigation-preferences", () => ({
  usePersonalNavigationPreferences: () => ({ preferences: { items: {} } }),
  useWorkspaceNavigationPreferences: () => ({ preferences: { items: {} } }),
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));

const { SidebarMenuItems } = await import("@/components/workspace/sidebar/sidebar-menu-items");

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

it("removes ordinary Plane entries from the first-level sidebar in IA v2", async () => {
  await act(async () => root.render(<SidebarMenuItems />));

  const keys = Array.from(container.querySelectorAll<HTMLElement>("a[data-key]")).map((link) => link.dataset.key);
  expect(keys).toContain("home");
  expect(keys).not.toContain("projects");
  expect(keys).not.toContain("views");
  expect(keys).not.toContain("analytics");
  expect(keys).not.toContain("archives");
  expect(container.textContent).not.toContain("common.workspace");
});

it("restores the ordinary workspace navigation when IA v2 is disabled", async () => {
  mocks.research.isIaV2Enabled = false;
  await act(async () => root.render(<SidebarMenuItems />));
  mocks.research.isIaV2Enabled = true;

  const keys = Array.from(container.querySelectorAll<HTMLElement>("a[data-key]")).map((link) => link.dataset.key);
  expect(keys).toEqual(["home", "projects", "views", "analytics", "archives"]);
  expect(container.textContent).toContain("common.workspace");
});
