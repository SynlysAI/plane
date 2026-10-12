// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clsx } from "clsx";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";
const mocks = vi.hoisted(() => ({
  businessItems: [
    { key: "reports", labelKey: "research.nav.reports", path: "reports", section: "reports" },
    { key: "summary", labelKey: "research.nav.summary", path: "reports/summary", section: "reports" },
    { key: "projects", labelKey: "research.nav.projects", path: "projects", section: "reports" },
    { key: "research_chain", labelKey: "research.nav.research_chain", path: "chains", section: "research_chain" },
    { key: "reviews", labelKey: "research.nav.reviews", path: "reviews", section: "stages" },
    { key: "approvals", labelKey: "research.nav.approvals", path: "approvals", section: "approvals" },
  ],
  settingItems: [
    { key: "org", labelKey: "research.nav.org_settings", path: "settings/org", section: "org" },
    { key: "system", labelKey: "research.nav.system", path: "settings/system", section: "org" },
    { key: "templates", labelKey: "research.nav.templates", path: "settings/templates", section: "reports" },
    { key: "identity", labelKey: "research.nav.identity", path: "settings/identity", section: "org" },
    { key: "platform", labelKey: "research.nav.platform", path: "settings/platform", section: "org" },
    { key: "audit", labelKey: "research.nav.audit", path: "audit", section: "org" },
    { key: "integrations", labelKey: "research.nav.integrations", path: "integrations", section: "integrations" },
  ],
  iaV2Items: [
    {
      key: "research_chain",
      labelKey: "research.nav.research_chain_v2",
      path: "chains",
      section: "research_chain",
    },
    { key: "approvals", labelKey: "research.nav.approvals_v2", path: "approvals", section: "approvals" },
    { key: "management", labelKey: "research.nav.management", path: "settings", section: "org" },
  ],
  research: {
    identityWorkspaceSlug: "lab",
    identity: {
      module_enabled: true,
      workspace_enabled: true,
      research_ia_v2: false,
      sections: {
        org: true,
        reports: true,
        approvals: true,
        stages: true,
        experiments: true,
        code: true,
        integrations: true,
        research_chain: false,
        research_agent: false,
      },
    },
    isEnabled: true,
    isIaV2Enabled: false,
    researchLevel: "RESEARCHER",
    visibleNavKeys: [
      "overview",
      "reports",
      "summary",
      "projects",
      "research_chain",
      "reviews",
      "approvals",
      "management",
      "org",
      "system",
      "templates",
      "identity",
      "platform",
      "audit",
      "integrations",
    ],
    canSee: (key: string) => mocks.research.visibleNavKeys.includes(key),
    identityLoader: false,
    identityErrorCode: null,
    isResearchAdmin: false,
  },
  workspace: { getWorkspaceBySlug: () => ({ name: "Lab" }) },
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ workspaceSlug: "lab" }), usePathname: () => "/lab/research" }));
vi.mock("react-router", () => ({ useParams: () => ({ workspaceSlug: "lab" }) }));
vi.mock("@plane/constants", async () => {
  return {
    RESEARCH_NAVIGATION_ITEMS: mocks.businessItems,
    RESEARCH_SETTINGS_NAVIGATION_ITEMS: mocks.settingItems,
    RESEARCH_IA_V2_NAVIGATION_ITEMS: mocks.iaV2Items,
  };
});
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.split(".").reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], translations) ?? key,
  }),
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ projectMap: {} }) }));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => mocks.workspace }));
vi.mock("@/services/research/navigation.service", () => ({
  ResearchNavigationService: class {
    getTree = (_workspaceSlug: string, scope: string) =>
      Promise.resolve(
        scope === "RESEARCH"
          ? {
              scope,
              can_manage: false,
              categories: [
                {
                  id: "research-category",
                  name: "重点课题",
                  kind: "CUSTOM",
                  scope,
                  parent: null,
                  sort_order: 0,
                  can_manage: false,
                  org_unit: null,
                  children: [],
                  projects: [{ id: "chain-1", name: "新材料课题", kind: "RESEARCH_CHAIN" }],
                },
              ],
              uncategorized: [],
            }
          : {
              scope,
              can_manage: false,
              categories: [
                {
                  id: "administrative-category",
                  name: "综合保障",
                  kind: "CUSTOM",
                  scope,
                  parent: null,
                  sort_order: 0,
                  can_manage: false,
                  org_unit: null,
                  children: [],
                  projects: [{ id: "admin-1", name: "年度采购", kind: "ADMINISTRATIVE" }],
                },
              ],
              uncategorized: [],
            }
      );
  },
}));
vi.mock("@headlessui/react", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- mock factory must create the component locally
  const Disclosure = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Disclosure.Button = (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />;
  Disclosure.Panel = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { Disclosure, Transition: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});
vi.mock("@makeplane/propel/icons", () => ({
  AddOutline: () => null,
  ChevronRightOutline: () => null,
  CloseOutline: () => null,
  InfoOutline: () => null,
  MoreHorizontalOutline: () => null,
  TickOutline: () => null,
  WarningTriangleOutline: () => null,
}));
vi.mock("@plane/propel/icon-button", () => ({
  IconButton: ({
    icon: _icon,
    iconClassName: _iconClassName,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: unknown; iconClassName?: string }) => (
    <button type="button" {...props} />
  ),
}));
vi.mock("@plane/utils", () => ({
  cn: clsx,
}));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("@/components/research/common/research-status-panel", () => ({
  ResearchStatusPanel: () => <div>status-panel</div>,
}));
vi.mock("@plane/ui", () => ({
  Spinner: () => <div>spinner</div>,
  EModalWidth: { SM: "sm" },
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  ModalCore: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div>{children}</div> : null,
}));

const { ResearchSidebarItems } = await import("@/components/research/navigation/research-sidebar-items");
const { ResearchPageShell } = await import("@/components/research/common/research-page-shell");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function setSwitches(researchChain: boolean, researchAgent = false, iaV2 = false) {
  mocks.research.identity.sections.research_chain = researchChain;
  mocks.research.identity.sections.research_agent = researchAgent;
  mocks.research.isIaV2Enabled = iaV2;
  mocks.research.identity.research_ia_v2 = iaV2;
}

it("keeps every existing research entry and hides 研究链 while the chain switch is off", async () => {
  setSwitches(false);
  const originalNavKeys = mocks.research.visibleNavKeys;
  mocks.research.visibleNavKeys = [
    "overview",
    ...mocks.businessItems.map((item) => item.key),
    ...mocks.settingItems.map((item) => item.key),
  ];
  await act(async () => root.render(<ResearchSidebarItems />));
  mocks.research.visibleNavKeys = originalNavKeys;
  expect(container.textContent).toContain("报告");
  expect(container.textContent).toContain("提交汇总");
  expect(container.textContent).toContain("科研项目");
  expect(container.textContent).toContain("待我评审");
  expect(container.textContent).toContain("办公审批");
  expect(container.textContent).toContain("组织架构");
  expect(container.textContent).toContain("系统集成");
  expect(container.textContent).not.toContain("研究链");
  expect(mocks.businessItems.some((item) => item.key === "research_chain")).toBe(true);
  expect(mocks.settingItems.map((item) => item.key)).toEqual([
    "org",
    "system",
    "templates",
    "identity",
    "platform",
    "audit",
    "integrations",
  ]);
});

it("shows 研究链 only when the workspace chain switch is on", async () => {
  setSwitches(true);
  await act(async () => root.render(<ResearchSidebarItems />));
  expect(container.textContent).toContain("研究链");
  const link = container.querySelector('a[href="/lab/research/chains"]');
  expect(link).not.toBeNull();
});

it("collapses research to the IA v2 project channels when IA v2 is enabled", async () => {
  setSwitches(true, false, true);
  await act(async () => root.render(<ResearchSidebarItems />));
  await act(async () => {});

  const links = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
  expect(links).toEqual([
    "/lab/research/settings",
    "/lab/research/approvals",
    "/lab/research/chains",
    "/lab/research/chains/chain-1?tab=overview",
    "/lab/projects",
    "/lab/projects/admin-1/issues",
  ]);
  expect(container.textContent).toContain("科研项目");
  expect(container.textContent).toContain("审批中心");
  expect(container.textContent).toContain("行政项目");
  expect(container.textContent).toContain("重点课题");
  expect(container.textContent).toContain("综合保障");
  expect(container.textContent).not.toContain("科研总览");
  expect(container.textContent).not.toContain("报告");
  expect(container.textContent).not.toContain("提交汇总");
  expect(container.textContent).not.toContain("待我评审");
  expect(container.querySelectorAll("a[href='/lab/research/chains/chain-1?tab=overview']")).toHaveLength(1);
  expect(container.querySelectorAll("a[href='/lab/research/chains']")).toHaveLength(1);
  expect(container.querySelectorAll("a[href='/lab/projects/admin-1/issues']")).toHaveLength(1);
});

it("shows the management destination only for callers with a management tab", async () => {
  setSwitches(true, false, true);
  const originalCanSee = mocks.research.canSee;
  mocks.research.canSee = (key: string) => key === "overview" || key === "research_chain" || key === "approvals";
  await act(async () => root.render(<ResearchSidebarItems />));
  mocks.research.canSee = originalCanSee;

  expect(container.querySelector('a[href="/lab/research/settings"]')).toBeNull();
});

it("将科研区收起后释放的高度交给行政区，并保留展开状态", async () => {
  setSwitches(true, false, true);
  await act(async () => root.render(<ResearchSidebarItems />));
  const researchTree = container.querySelector('[data-navigation-scope="RESEARCH"]');
  const administrativeTree = container.querySelector('[data-navigation-scope="ADMINISTRATIVE"]');
  expect(researchTree?.classList.contains("grow")).toBe(true);
  expect(administrativeTree?.classList.contains("grow")).toBe(false);

  const collapseButton = researchTree?.querySelector<HTMLButtonElement>('button[aria-label="收起科研项目"]');
  if (!collapseButton) throw new Error("未找到科研区收起按钮");
  await act(async () => collapseButton.click());

  expect(researchTree?.textContent).not.toContain("新材料课题");
  expect(administrativeTree?.classList.contains("grow")).toBe(true);
  expect(localStorage.getItem("research_navigation_research_open")).toBe("false");

  await act(async () => root.render(null));
  await act(async () => root.render(<ResearchSidebarItems />));
  expect(container.querySelector('[data-navigation-scope="RESEARCH"]')?.textContent).not.toContain("新材料课题");
  expect(container.querySelector('[data-navigation-scope="ADMINISTRATIVE"]')?.classList.contains("grow")).toBe(true);

  const expandButton = container.querySelector<HTMLButtonElement>('button[aria-label="展开科研项目"]');
  if (!expandButton) throw new Error("未找到科研区展开按钮");
  await act(async () => expandButton.click());
  expect(container.querySelector('[data-navigation-scope="RESEARCH"]')?.classList.contains("grow")).toBe(true);
  expect(container.querySelector('[data-navigation-scope="ADMINISTRATIVE"]')?.classList.contains("grow")).toBe(false);
});

it("科研区不可见时行政区使用剩余高度", async () => {
  setSwitches(true, false, true);
  const originalNavKeys = mocks.research.visibleNavKeys;
  mocks.research.visibleNavKeys = originalNavKeys.filter((key) => key !== "research_chain");
  try {
    await act(async () => root.render(<ResearchSidebarItems />));
    expect(container.querySelector('[data-navigation-scope="RESEARCH"]')).toBeNull();
    expect(container.querySelector('[data-navigation-scope="ADMINISTRATIVE"]')?.classList.contains("grow")).toBe(true);
  } finally {
    mocks.research.visibleNavKeys = originalNavKeys;
  }
});

it("行政区收起时科研区继续占用剩余高度", async () => {
  setSwitches(true, false, true);
  await act(async () => root.render(<ResearchSidebarItems />));
  const collapseButton = container.querySelector<HTMLButtonElement>('button[aria-label="收起行政项目"]');
  if (!collapseButton) throw new Error("未找到行政区收起按钮");
  await act(async () => collapseButton.click());
  expect(container.querySelector('[data-navigation-scope="RESEARCH"]')?.classList.contains("grow")).toBe(true);
  expect(container.querySelector('[data-navigation-scope="ADMINISTRATIVE"]')?.textContent).not.toContain("年度采购");
});

it("guards the agent route with the independent workspace switch", async () => {
  setSwitches(true, false);
  await act(async () =>
    root.render(
      <ResearchPageShell titleKey="research.nav.research_chain" section="research_agent" navKey="research_chain">
        <div>agent-body</div>
      </ResearchPageShell>
    )
  );
  expect(container.textContent).toContain("status-panel");
  expect(container.textContent).not.toContain("agent-body");

  setSwitches(true, true);
  await act(async () =>
    root.render(
      <ResearchPageShell titleKey="research.nav.research_chain" section="research_agent" navKey="research_chain">
        <div>agent-body</div>
      </ResearchPageShell>
    )
  );
  expect(container.textContent).toContain("agent-body");
});
