// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  pathname: "/lab/",
  toggleSidebar: vi.fn(),
  research: {
    isEnabled: true,
    isIaV2Enabled: true,
    identityWorkspaceSlug: "lab",
    identity: { sections: { org: true, reports: true, approvals: true, integrations: true } },
    visibleNavKeys: [] as string[],
    canSee: (key: string): boolean => mocks.research.visibleNavKeys.includes(key),
  },
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "lab" }),
  usePathname: () => mocks.pathname,
}));
vi.mock("next/link", () => ({
  default: ({ href, children, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      {...props}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/store/use-app-theme", () => ({
  useAppTheme: () => ({
    isExtendedSidebarOpened: false,
    toggleExtendedSidebar: vi.fn(),
    toggleSidebar: mocks.toggleSidebar,
  }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: { id: "user-1" } }),
  useUserPermissions: () => ({ allowPermissions: () => true }),
}));
vi.mock("@/hooks/use-local-storage", () => ({
  default: () => ({ storedValue: true, setValue: vi.fn() }),
}));
vi.mock("@/hooks/use-navigation-preferences", () => ({
  usePersonalNavigationPreferences: () => ({ preferences: { items: {} } }),
  useWorkspaceNavigationPreferences: () => ({
    preferences: { items: {} },
    isWorkspaceItemPinned: () => !mocks.research.isIaV2Enabled,
  }),
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));

const { SidebarMenuItems } = await import("@/components/workspace/sidebar/sidebar-menu-items");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  mocks.pathname = "/lab/";
  mocks.research.isEnabled = true;
  mocks.research.isIaV2Enabled = true;
  mocks.research.identityWorkspaceSlug = "lab";
  mocks.research.visibleNavKeys = [];
  mocks.research.identity.sections.approvals = true;
  mocks.research.identity.sections.org = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("removes ordinary Plane entries from the first-level sidebar in IA v2", async () => {
  await act(async () => root.render(<SidebarMenuItems />));

  const links = [...container.querySelectorAll("a")];
  expect(links.map((link) => link.getAttribute("href"))).toEqual(["/lab/"]);
  expect(container.firstElementChild?.children.length).toBe(1);
  expect(links[0].firstElementChild?.classList.contains("h-8")).toBe(true);
  expect(container.textContent).not.toContain("common.workspace");
});

it("restores the ordinary workspace navigation when IA v2 is disabled", async () => {
  mocks.research.isIaV2Enabled = false;
  await act(async () => root.render(<SidebarMenuItems />));
  mocks.research.isIaV2Enabled = true;

  const links = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
  expect(links).toEqual([
    "/lab/",
    "/lab/projects/",
    "/lab/workspace-views/all-issues/",
    "/lab/analytics/",
    "/lab/projects/archives/",
  ]);
  expect(container.textContent).toContain("common.workspace");
});

it("groups home, approvals and management in order with matching icons and rows", async () => {
  mocks.research.visibleNavKeys = ["approvals", "org"];
  await act(async () => root.render(<SidebarMenuItems />));

  const links = [...container.querySelectorAll("a")];
  expect(links.map((link) => link.getAttribute("href"))).toEqual([
    "/lab/",
    "/lab/research/approvals",
    "/lab/research/settings",
  ]);
  expect(container.firstElementChild?.children.length).toBe(3);
  for (const link of links) {
    expect(link.parentElement).toBe(container.firstElementChild);
    expect(link.firstElementChild?.className).toContain("h-8");
    expect(link.querySelector("svg")?.classList.contains("size-4")).toBe(true);
  }
});

it.each(["org", "system", "templates", "integrations"])(
  "shows management for a caller with the %s tab",
  async (key) => {
    mocks.research.visibleNavKeys = [key];
    await act(async () => root.render(<SidebarMenuItems />));
    expect(container.querySelector('a[href="/lab/research/settings"]')).not.toBeNull();
    expect(container.querySelector('a[href="/lab/research/approvals"]')).toBeNull();
  }
);

it("hides entries for disabled sections and stale workspace permissions", async () => {
  mocks.research.visibleNavKeys = ["approvals", "org"];
  mocks.research.identity.sections.approvals = false;
  mocks.research.identity.sections.org = false;
  await act(async () => root.render(<SidebarMenuItems />));
  expect(container.querySelectorAll("a")).toHaveLength(1);

  mocks.research.identity.sections.approvals = true;
  mocks.research.identity.sections.org = true;
  mocks.research.identityWorkspaceSlug = "another-workspace";
  await act(async () => root.render(<SidebarMenuItems />));
  expect(container.querySelectorAll("a")).toHaveLength(1);
});

it.each(["/lab/research/approvals/", "/lab/research/approvals/request-1/"])(
  "highlights approvals and closes the mobile sidebar at %s",
  async (pathname) => {
    mocks.pathname = pathname;
    mocks.research.visibleNavKeys = ["approvals", "org"];
    vi.stubGlobal("innerWidth", 375);
    await act(async () => root.render(<SidebarMenuItems />));
    const activeLinks = container.querySelectorAll<HTMLAnchorElement>('a[aria-current="page"]');
    expect(activeLinks).toHaveLength(1);
    expect(activeLinks[0].getAttribute("href")).toBe("/lab/research/approvals");

    await act(async () => activeLinks[0].click());
    expect(mocks.toggleSidebar).toHaveBeenCalledTimes(1);
  }
);
