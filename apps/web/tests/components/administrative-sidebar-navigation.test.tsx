// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ pathname: "/lab/approvals", toggle: vi.fn(), research: { identityWorkspaceSlug: "lab", identity: { navigation: { management: false } } } }));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({ useParams: () => ({ workspaceSlug: "lab" }), usePathname: () => mocks.pathname }));
vi.mock("next/link", () => ({ default: ({ href, children, onClick, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...rest} onClick={(event) => { event.preventDefault(); onClick?.(event); }}>{children}</a> }));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));
vi.mock("@/hooks/store/use-app-theme", () => ({ useAppTheme: () => ({ toggleSidebar: mocks.toggle }) }));
const { SidebarMenuItems } = await import("@/components/workspace/sidebar/sidebar-menu-items");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement; let root: ReturnType<typeof createRoot>;
beforeEach(() => { container = document.createElement("div"); root = createRoot(container); mocks.research.identityWorkspaceSlug = "lab"; mocks.research.identity.navigation.management = false; });
afterEach(async () => { await act(async () => root.unmount()); vi.clearAllMocks(); vi.unstubAllGlobals(); });
it("keeps home and approvals available without research permissions", async () => {
  await act(async () => root.render(<SidebarMenuItems />));
  expect([...container.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/lab", "/lab/approvals"]);
});
it("renders management from workspace capabilities", async () => {
  mocks.research.identity.navigation.management = true;
  await act(async () => root.render(<SidebarMenuItems />));
  expect(container.querySelector('a[href="/lab/management"]')).not.toBeNull();
});
it("never reuses another workspace's navigation", async () => {
  mocks.research.identityWorkspaceSlug = "other";
  await act(async () => root.render(<SidebarMenuItems />));
  expect(container.querySelector("a")).toBeNull();
});
it("highlights the current destination and closes mobile navigation", async () => {
  vi.stubGlobal("innerWidth", 375);
  await act(async () => root.render(<SidebarMenuItems />));
  const link = container.querySelector<HTMLAnchorElement>('a[aria-current="page"]');
  expect(link?.getAttribute("href")).toBe("/lab/approvals");
  await act(async () => link?.click()); expect(mocks.toggle).toHaveBeenCalledOnce();
});
