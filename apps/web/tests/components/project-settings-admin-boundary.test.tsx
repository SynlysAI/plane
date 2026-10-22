// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EUserProjectRoles } from "@plane/types";
import { PROJECT_SETTINGS } from "@plane/constants";

const mocks = vi.hoisted(() => ({
  projectRole: 20,
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("react-router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useLocation: () => ({ pathname: "/lab/projects/project/issues/" }),
  useParams: () => ({ workspaceSlug: "lab" }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/lab/settings/projects/project/members/",
}));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/navigation/project-header", () => ({ ProjectHeader: () => <strong>project</strong> }));
vi.mock("@/components/navigation/use-navigation-items", () => ({ useNavigationItems: () => [] }));
vi.mock("@/components/settings/helper", () => ({ getProjectActivePath: () => "" }));
vi.mock("@/components/settings/mobile/nav", () => ({ SettingsMobileNav: () => <nav /> }));
vi.mock("@/components/settings/project/sidebar", () => ({ ProjectSettingsSidebarRoot: () => <aside /> }));
vi.mock("@/components/auth-screens/not-authorized-view", () => ({
  NotAuthorizedView: () => <section data-testid="project-settings-denied">denied</section>,
}));
vi.mock("@/layouts/auth-layout/project-wrapper", () => ({
  ProjectAuthWrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ getPartialProjectById: () => ({ id: "project" }) }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({
    workspaceUserInfo: { lab: { role: 15 } },
    allowPermissions: (allowedRoles: number[]) => allowedRoles.includes(mocks.projectRole),
  }),
}));
vi.mock("@/components/settings/sidebar/item", () => ({
  SettingsSidebarItem: ({ href, label }: { href: string; label: string }) => <a href={href}>{label}</a>,
}));
vi.mock("@/components/settings/project/sidebar/item-icon", () => ({
  PROJECT_SETTINGS_ICONS: new Proxy({}, { get: () => () => null }),
}));

const { TabNavigationRoot } = await import("@/components/navigation/tab-navigation-root");
const { ProjectSettingsSidebarItemCategories } = await import("@/components/settings/project/sidebar/item-categories");
const { default: ProjectDetailSettingsLayout } =
  await import("@/app/(all)/[workspaceSlug]/(settings)/settings/projects/[projectId]/layout");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  mocks.projectRole = 20;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("keeps every project settings tab admin-only", () => {
  const adminOnlySettings = Object.values(PROJECT_SETTINGS);

  for (const item of adminOnlySettings) {
    expect(item.access).toEqual([EUserProjectRoles.ADMIN]);
  }
});

it("hides the project settings entry and sidebar for an ordinary project member", async () => {
  mocks.projectRole = EUserProjectRoles.MEMBER;

  await act(async () =>
    root.render(
      <>
        <TabNavigationRoot workspaceSlug="lab" projectId="project" />
        <ProjectSettingsSidebarItemCategories projectId="project" />
      </>
    )
  );

  const links = Array.from(container.querySelectorAll("a")).map((link) => link.getAttribute("href"));
  expect(links).not.toContain("/lab/settings/projects/project");
  expect(links).not.toContain("/lab/settings/projects/project/members/");
  expect(links).toContain("/lab/projects/project/archives/issues");
});

it("keeps project settings available to a project admin", async () => {
  await act(async () =>
    root.render(
      <>
        <TabNavigationRoot workspaceSlug="lab" projectId="project" />
        <ProjectSettingsSidebarItemCategories projectId="project" />
      </>
    )
  );

  const links = Array.from(container.querySelectorAll("a")).map((link) => link.getAttribute("href"));
  expect(links).toContain("/lab/settings/projects/project");
  expect(links).toContain("/lab/settings/projects/project/members/");
});

it("blocks a direct project settings URL for an ordinary project member", async () => {
  mocks.projectRole = EUserProjectRoles.MEMBER;

  await act(async () =>
    root.render(<ProjectDetailSettingsLayout params={{ workspaceSlug: "lab", projectId: "project" }} />)
  );

  expect(container.querySelector("[data-testid='project-settings-denied']")).not.toBeNull();
});
