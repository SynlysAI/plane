// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      return typeof value === "string" ? value : key;
    },
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@plane/propel/tab-navigation", () => ({
  TabNavigationList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/research/common/research-tab-link", async () => {
  const { Link } = await import("react-router");
  return {
    ResearchTabLink: ({ href, isActive, children }: { href: string; isActive: boolean; children: React.ReactNode }) => (
      <Link to={href} aria-current={isActive ? "page" : undefined}>
        {children}
      </Link>
    ),
  };
});
vi.mock("@/components/research/common/research-page-shell", () => ({
  ResearchPageShell: ({ children, hideHeader }: { children: React.ReactNode; hideHeader?: boolean }) => (
    <div data-hide-header={hideHeader}>{children}</div>
  ),
}));
vi.mock("@/components/research/approvals/approval-list", () => ({
  ResearchApprovalList: () => <div>office-approvals</div>,
}));
vi.mock("@/components/research/approvals/chain-stage-approval-inbox", () => ({
  ChainStageApprovalInbox: () => <div>chain-stage-approvals</div>,
}));
vi.mock("@/components/research/reports/report-list", () => ({
  ResearchReportList: () => <div>report-list</div>,
}));
vi.mock("@/components/research/reviews/review-inbox", () => ({
  ReviewInbox: () => <div>review-inbox</div>,
}));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    identity: {
      sections: {
        reports: true,
        approvals: true,
        stages: true,
        research_chain: true,
      },
    },
    isIaV2Enabled: true,
    isWorkspaceAdmin: false,
    isResearchAdmin: false,
    canSee: () => true,
  }),
}));

const { ResearchApprovalCenter } = await import("@/components/research/approvals/research-approval-center");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let currentSearch = "";

function RouteProbe() {
  const location = useLocation();
  currentSearch = location.search;
  return null;
}

function renderCenter(initialPath: string) {
  return act(async () =>
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <ResearchApprovalCenter workspaceSlug="lab" />
        <RouteProbe />
      </MemoryRouter>
    )
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  currentSearch = "";
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("renders only research queues with canonical page-level links", async () => {
  await renderCenter("/lab/approvals?domain=research&tab=report_review&todo_scope=visible");
  await act(async () => undefined);

  expect(container.querySelector("[data-hide-header='true']")).not.toBeNull();
  const nav = container.querySelector('nav[aria-label="审批中心"]');
  expect(Array.from(nav?.querySelectorAll("a") ?? []).map((link) => link.textContent)).toEqual([
    "科研链阶段",
    "阶段评审",
    "报告审核",
    "办公审批",
  ]);
  expect(nav?.textContent).not.toContain("跨组件待办");
  expect(container.textContent).toContain("report-list");

  const stageTab = [...container.querySelectorAll("a")].find((link) => link.textContent === "阶段评审");
  expect(stageTab?.getAttribute("href")).toBe("/lab/approvals?domain=research&tab=stage_review&todo_scope=visible");
  await act(async () => stageTab?.click());
  await act(async () => undefined);

  expect(container.textContent).toContain("review-inbox");
  expect(container.textContent).not.toContain("report-list");
});

it("renders the research chain stage queue and keeps its deep link", async () => {
  await renderCenter("/lab/approvals?domain=research&tab=chain_stage&todo_scope=visible");
  await act(async () => undefined);

  expect(container.textContent).toContain("chain-stage-approvals");
  const chainStageTab = [...container.querySelectorAll("a")].find((link) =>
    link.getAttribute("href")?.includes("tab=chain_stage")
  );
  expect(chainStageTab?.getAttribute("href")).toBe("/lab/approvals?domain=research&tab=chain_stage&todo_scope=visible");
});

it("keeps todo scope while switching research queues", async () => {
  await renderCenter("/lab/approvals?domain=research&todo_scope=visible");
  await act(async () => undefined);

  const officeTab = [...container.querySelectorAll("a")].find((link) =>
    link.getAttribute("href")?.includes("tab=office")
  );
  expect(officeTab?.getAttribute("href")).toBe("/lab/approvals?domain=research&tab=office&todo_scope=visible");
  await act(async () => officeTab?.click());
  await act(async () => undefined);

  expect(currentSearch).toBe("?domain=research&tab=office&todo_scope=visible");
  expect(container.textContent).toContain("office-approvals");
  expect(container.textContent).not.toContain("跨组件待办");
});
