// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  research: {
    isEnabled: true,
    isIaV2Enabled: true,
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
vi.mock("@/components/research/common/research-tab-link", () => ({
  ResearchTabLink: ({ href, isActive, children }: { href: string; isActive: boolean; children: React.ReactNode }) => (
    <a href={href} data-active={isActive ? "true" : "false"}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));

const { AdministrativeProjectTabs } = await import("@/components/administrative/administrative-project-tabs");

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
    { href: "/lab/workspace-views/all-issues/", label: "administrative.views.title", active: "false" },
    { href: "/lab/analytics/overview/", label: "administrative.analytics.title", active: "false" },
    { href: "/lab/projects/archives", label: "administrative.archives.title", active: "false" },
  ]);
});

it("keeps organization creation out of the administrative page heading", async () => {
  await act(async () =>
    root.render(
      <AdministrativeProjectTabs workspaceSlug="lab" activeTab="projects">
        <output>ordinary-plane-body</output>
      </AdministrativeProjectTabs>
    )
  );

  const button = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === "新建组织");
  expect(button).toBeFalsy();
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
  mocks.research.isIaV2Enabled = true;

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
