// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
    { key: "overview", labelKey: "research.nav.overview", path: "", section: null },
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
    visibleNavKeys: ["overview", "reports", "summary", "projects", "research_chain", "reviews", "approvals"],
    canSee: (key: string) => mocks.research.visibleNavKeys.includes(key),
    identityLoader: false,
    identityErrorCode: null,
    isResearchAdmin: false,
  },
  workspace: { getWorkspaceBySlug: () => ({ name: "Lab" }) },
  stored: true,
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
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => mocks.workspace }));
vi.mock("@/hooks/use-local-storage", () => ({
  default: () => [mocks.stored, vi.fn()],
}));
vi.mock("@headlessui/react", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- mock factory must create the component locally
  const Disclosure = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Disclosure.Button = (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />;
  Disclosure.Panel = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return { Disclosure, Transition: ({ children }: { children: React.ReactNode }) => <div>{children}</div> };
});
vi.mock("@makeplane/propel/icons", () => ({ ChevronRightOutline: () => null }));
vi.mock("@plane/propel/icon-button", () => ({ IconButton: () => <button type="button" /> }));
vi.mock("@plane/utils", () => ({
  cn: (...values: Array<string | false | undefined>) => values.filter(Boolean).join(" "),
}));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("@/components/research/common/research-status-panel", () => ({
  ResearchStatusPanel: () => <div>status-panel</div>,
}));
vi.mock("@plane/ui", () => ({ Spinner: () => <div>spinner</div> }));

const { ResearchSidebarItems } = await import("@/components/research/navigation/research-sidebar-items");
const { ResearchPageShell } = await import("@/components/research/common/research-page-shell");

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

it("collapses research to four destinations when IA v2 is enabled", async () => {
  setSwitches(true, false, true);
  await act(async () => root.render(<ResearchSidebarItems />));

  const links = [...container.querySelectorAll("a")].map((link) => link.getAttribute("href"));
  expect(links).toEqual(["/lab/research", "/lab/research/chains", "/lab/research/approvals"]);
  expect(container.textContent).toContain("研究链");
  expect(container.textContent).toContain("审批中心");
  expect(container.textContent).not.toContain("报告");
  expect(container.textContent).not.toContain("提交汇总");
  expect(container.textContent).not.toContain("科研项目");
  expect(container.textContent).not.toContain("待我评审");
});

it("shows the management destination only for callers with a management tab", async () => {
  setSwitches(true, false, true);
  const originalCanSee = mocks.research.canSee;
  mocks.research.canSee = (key: string) => key === "overview" || key === "research_chain" || key === "approvals";
  await act(async () => root.render(<ResearchSidebarItems />));
  mocks.research.canSee = originalCanSee;

  expect(container.querySelector('a[href="/lab/research/settings"]')).toBeNull();
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
