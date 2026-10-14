// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  research: {
    isEnabled: true,
    isIaV2Enabled: true,
    isWorkspaceAdmin: false,
    isResearchAdmin: false,
    identity: { user: { org_units: [{ id: "unit-1" }] } } as { user: { org_units: { id: string }[] } } | null,
    identityWorkspaceSlug: "lab" as string | null,
    identityErrorCode: null as string | null,
    identityLoader: false,
    fetchIdentity: vi.fn().mockResolvedValue({}),
    canSee: (key: string): boolean => key === "projects",
  },
}));

vi.mock("mobx-react", () => ({
  enableStaticRendering: () => undefined,
  observer: (component: unknown) => component,
}));
vi.mock("@plane/i18n", () => ({
  DEFAULT_LANGUAGE: "en",
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@plane/propel/tab-navigation", () => ({
  TabNavigationList: ({ children }: { children: React.ReactNode }) => <nav>{children}</nav>,
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "success", ERROR: "error" },
  setToast: vi.fn(),
}));
vi.mock("@plane/ui", () => ({
  EModalWidth: { SM: "sm" },
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  ModalCore: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div>{children}</div> : null,
}));
vi.mock("@/components/research/common/research-tab-link", () => ({
  ResearchTabLink: ({ href, isActive, children }: { href: string; isActive: boolean; children: React.ReactNode }) => (
    <a href={href} data-active={isActive ? "true" : "false"}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ fetchProjects: vi.fn() }) }));
vi.mock("@/services/research/navigation.service", () => ({
  ResearchNavigationService: class {
    createAdministrativeOrganization = vi.fn();
  },
}));

const { AdministrativeProjectTabs } = await import("@/components/administrative/administrative-project-tabs");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** 恢复行政页签测试的默认 identity 与权限。 */
function resetResearch() {
  mocks.research.isEnabled = true;
  mocks.research.isIaV2Enabled = true;
  mocks.research.isWorkspaceAdmin = false;
  mocks.research.isResearchAdmin = false;
  mocks.research.identity = { user: { org_units: [{ id: "unit-1" }] } };
  mocks.research.identityWorkspaceSlug = "lab";
  mocks.research.identityErrorCode = null;
  mocks.research.identityLoader = false;
  mocks.research.canSee = (key: string): boolean => key === "projects";
  mocks.research.fetchIdentity.mockClear();
}

beforeEach(() => {
  resetResearch();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("keeps the research and administrative channel copy unambiguous in Chinese", () => {
  expect(translations.administrative?.projects?.boundary).toContain("行政项目不是科研项目");
  expect(translations.administrative?.projects?.boundary).toContain("行政任务不写入 Chain Event");
  expect(translations.research?.approvals?.description).toContain("行政 / 办公审批");
  expect(translations.research?.chains?.description).toContain("行政项目不在本通道显示");
});

it("renders the four ordinary Plane capabilities in the administrative channel", async () => {
  await act(async () =>
    root.render(
      <AdministrativeProjectTabs workspaceSlug="lab" activeTab="projects">
        <output>ordinary-plane-body</output>
      </AdministrativeProjectTabs>
    )
  );

  expect(container.querySelector("h2")?.textContent).toBe("administrative.projects.title");
  expect(container.textContent).toContain("administrative.projects.description");
  expect(container.textContent).toContain("administrative.projects.boundary");
  expect(container.textContent).toContain("ordinary-plane-body");
  expect(container.textContent).not.toContain("research.chains.views.chains");

  const links = Array.from(container.querySelectorAll("a")).map((link) => ({
    href: link.getAttribute("href"),
    label: link.textContent,
    active: link.dataset.active,
  }));
  expect(links).toEqual([
    { href: "/lab/projects", label: "administrative.projects.title", active: "true" },
    { href: "/lab/research/projects", label: "research.nav.projects", active: "false" },
    { href: "/lab/workspace-views/all-issues/", label: "administrative.views.title", active: "false" },
    { href: "/lab/analytics/overview/", label: "administrative.analytics.title", active: "false" },
    { href: "/lab/projects/archives", label: "administrative.archives.title", active: "false" },
  ]);
});

it("keeps ordinary pages unchanged when IA v2 is disabled", async () => {
  mocks.research.isIaV2Enabled = false;
  await act(async () =>
    root.render(
      <AdministrativeProjectTabs workspaceSlug="lab" activeTab="projects">
        <output>legacy-plane-body</output>
      </AdministrativeProjectTabs>
    )
  );

  expect(container.textContent).toBe("legacy-plane-body");
  expect(container.querySelector("a")).toBeNull();
});

it("allows the secondary tabs to scroll independently on narrow screens", async () => {
  await act(async () =>
    root.render(
      <AdministrativeProjectTabs workspaceSlug="lab" activeTab="archives">
        <output>ordinary-plane-body</output>
      </AdministrativeProjectTabs>
    )
  );

  const nav = container.querySelector('nav[aria-label="administrative.projects.title"]');
  expect(nav?.className).toContain("overflow-x-auto");
  expect(nav?.className).not.toContain("overflow-y-auto");
});

it("does not render administrative chrome until identity is ready", async () => {
  mocks.research.identity = null;
  mocks.research.identityWorkspaceSlug = null;
  await act(async () =>
    root.render(
      <AdministrativeProjectTabs workspaceSlug="lab" activeTab="projects">
        <output>pending-identity</output>
      </AdministrativeProjectTabs>
    )
  );

  expect(container.textContent).toBe("pending-identity");
  expect(container.querySelector("a")).toBeNull();
  expect(mocks.research.fetchIdentity).toHaveBeenCalledWith("lab");
});

it("hides the research tab without project capability or research admin rights", async () => {
  mocks.research.canSee = () => false;
  mocks.research.isResearchAdmin = false;
  await act(async () =>
    root.render(
      <AdministrativeProjectTabs workspaceSlug="lab" activeTab="projects">
        <output>ordinary-plane-body</output>
      </AdministrativeProjectTabs>
    )
  );

  const labels = Array.from(container.querySelectorAll("a")).map((link) => link.textContent);
  expect(labels).not.toContain("research.nav.projects");
  expect(labels).toContain("administrative.projects.title");
});

it("shows the research tab for a research admin without project capability", async () => {
  mocks.research.canSee = () => false;
  mocks.research.isResearchAdmin = true;
  await act(async () =>
    root.render(
      <AdministrativeProjectTabs workspaceSlug="lab" activeTab="projects">
        <output>ordinary-plane-body</output>
      </AdministrativeProjectTabs>
    )
  );

  expect(Array.from(container.querySelectorAll("a")).map((link) => link.textContent)).toContain(
    "research.nav.projects"
  );
});

it("uses the research title and hides administrative chrome on the research projects tab", async () => {
  mocks.research.isWorkspaceAdmin = true;
  await act(async () =>
    root.render(
      <AdministrativeProjectTabs workspaceSlug="lab" activeTab="research-projects">
        <output>research-body</output>
      </AdministrativeProjectTabs>
    )
  );

  expect(container.querySelector("h2")?.textContent).toBe("research.nav.projects");
  expect(container.querySelector("h2")?.textContent).not.toBe("administrative.projects.title");
  expect(container.textContent).toContain("research.projects.description");
  expect(container.textContent).not.toContain("administrative.projects.boundary");
  expect(container.textContent).not.toContain("新建组织");
  expect(container.textContent).toContain("research-body");
});
