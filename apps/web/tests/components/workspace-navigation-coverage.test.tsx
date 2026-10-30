// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  routeParams: { workspaceSlug: "lab" } as Record<string, string | undefined>,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useParams: () => mocks.routeParams,
  usePathname: () => "/lab",
}));
vi.mock("react-router", () => ({ useParams: () => mocks.routeParams }));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => translationText(key) }),
}));
vi.mock("@makeplane/propel/icons", () => ({
  HomeOutline: () => <svg aria-hidden="true" />,
}));
vi.mock("@makeplane/propel/components/avatar", () => ({
  Avatar: () => <span aria-hidden="true" />,
}));
vi.mock("@plane/propel/scrollarea", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@plane/utils", () => ({
  getFileURL: (value: string) => value,
  cn: (...values: string[]) => values.join(" "),
}));
vi.mock("@plane/ui", () => ({ Spinner: () => <span aria-hidden="true" /> }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: undefined }) }));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({ getWorkspaceBySlug: () => ({ name: "Lab" }) }),
}));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    identity: { module_enabled: true, workspace_enabled: true, sections: { reports: true } },
    identityWorkspaceSlug: "lab",
    identityLoader: false,
    identityErrorCode: undefined,
    isEnabled: true,
    canSee: () => true,
    isResearchAdmin: false,
    fetchIdentity: vi.fn(),
  }),
}));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("@/components/research/common/research-status-panel", () => ({
  ResearchStatusPanel: () => <div role="alert" />,
}));
vi.mock("@/components/research/navigation/research-management-tabs", () => ({
  ResearchManagementTabs: () => <nav aria-label="管理导航" />,
}));
vi.mock("@/components/settings/profile/sidebar/item-categories", () => ({
  ProfileSettingsSidebarItemCategories: () => <nav aria-label="个人设置导航" />,
}));

const { WorkspaceHomeLink } = await import("@/components/common/workspace-home-link");
const { ProfileSettingsSidebarRoot } = await import("@/components/settings/profile/sidebar/root");
const { resolveProfileReturnWorkspaceSlug } = await import("@/components/settings/profile/sidebar/header");
const { ResearchPageShell } = await import("@/components/research/common/research-page-shell");

/** 将受控测试语言键转换为稳定中文文案。 */
function translationText(key: string) {
  if (key === "back_to_home") return "返回首页";
  if (key === "back_to_workspace") return "返回工作区";
  return key;
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.routeParams = { workspaceSlug: "lab" };
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("renders an explicit and route-derived workspace home link", async () => {
  await act(async () => root.render(<WorkspaceHomeLink workspaceSlug="explicit" />));
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/explicit");
  expect(container.textContent).toContain("返回首页");

  await act(async () => root.render(<WorkspaceHomeLink />));
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/lab");

  mocks.routeParams = {};
  await act(async () => root.render(<WorkspaceHomeLink />));
  expect(container.querySelector("a")).toBeNull();
});

it("resolves the profile return workspace in priority order", () => {
  const workspaces = [{ slug: "first" }];
  expect(
    resolveProfileReturnWorkspaceSlug({
      queryWorkspaceSlug: "query",
      lastWorkspaceSlug: "last",
      fallbackWorkspaceSlug: "fallback",
      workspaces,
    })
  ).toBe("query");
  expect(
    resolveProfileReturnWorkspaceSlug({
      lastWorkspaceSlug: "last",
      fallbackWorkspaceSlug: "fallback",
      workspaces,
    })
  ).toBe("last");
  expect(resolveProfileReturnWorkspaceSlug({ fallbackWorkspaceSlug: "fallback", workspaces })).toBe("fallback");
  expect(resolveProfileReturnWorkspaceSlug({ workspaces })).toBe("first");
  expect(resolveProfileReturnWorkspaceSlug({ workspaces: [] })).toBeUndefined();
});

it("shows a workspace return entry at the top of profile settings", async () => {
  await act(async () =>
    root.render(
      <ProfileSettingsSidebarRoot activeTab="general" updateActiveTab={() => undefined} returnWorkspaceSlug="lab" />
    )
  );

  const homeLink = container.querySelector('a[href="/lab"]');
  expect(homeLink?.textContent).toContain("返回工作区");
  expect(homeLink?.compareDocumentPosition(container.querySelector("nav")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

it("keeps the workspace home link beside research detail breadcrumbs", async () => {
  await act(async () =>
    root.render(
      <ResearchPageShell
        titleKey="research.reports.detail_title"
        section="reports"
        breadcrumbs={<span>返回报告列表</span>}
      >
        <p>report detail</p>
      </ResearchPageShell>
    )
  );

  expect(container.querySelector('a[href="/lab"]')?.textContent).toContain("返回首页");
  expect(container.textContent).toContain("返回报告列表");
});

it("keeps every surface outside the project sidebar anchored to workspace home", () => {
  const webRoot = path.resolve(__dirname, "../..");
  const surfaces = [
    "core/components/inbox/inbox-sidebar.tsx",
    "core/components/research/common/research-page-shell.tsx",
    "core/components/settings/workspace/sidebar/header.tsx",
    "core/components/settings/profile/sidebar/header.tsx",
    "app/(all)/[workspaceSlug]/(settings)/settings/(workspace)/layout.tsx",
    "app/(all)/[workspaceSlug]/(settings)/settings/projects/[projectId]/layout.tsx",
    "app/(all)/[workspaceSlug]/(settings)/settings/projects/page.tsx",
  ];

  for (const surface of surfaces) {
    const source = readFileSync(path.join(webRoot, surface), "utf8");
    expect(source, surface).toContain("WorkspaceHomeLink");
  }
});
