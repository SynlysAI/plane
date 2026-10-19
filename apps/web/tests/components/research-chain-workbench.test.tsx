// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("mobx-react", () => ({
  observer: (component: unknown) => component,
  enableStaticRendering: vi.fn(),
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  DEFAULT_LANGUAGE: "zh-CN",
}));
vi.mock("@plane/propel/tab-navigation", () => ({
  TabNavigationList: ({ children }: { children: React.ReactNode }) => <nav>{children}</nav>,
}));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@/components/research/common/research-tab-link", () => ({
  ResearchTabLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/research/chains/research-chain-board", () => ({
  ResearchChainBoard: () => <output>chain-board</output>,
}));
vi.mock("@/components/research/reports/report-list", () => ({
  ResearchReportList: () => <output>report-outcome-workbench</output>,
}));
vi.mock("@/components/research/projects/research-project-create-dialog", () => ({
  ResearchProjectCreateDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog">research.projects.create_title</div> : null,
}));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    isIaV2Enabled: true,
    isWorkspaceAdmin: true,
    identity: { user: { org_units: [] } },
  }),
}));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: { id: "user-1" } }) }));

vi.mock("@/components/research/projects/research-project-list", () => ({ ResearchProjectList: () => <div>research-project-records</div> }));

const { ResearchChainWorkbench } = await import("@/components/research/chains/research-chain-workbench");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** 渲染 IA v2 研究链工作台。 */
async function render(entry: string) {
  function Probe() {
    const location = useLocation();
    return (
      <>
        <ResearchChainWorkbench workspaceSlug="lab" />
        <output aria-label="URL">{`${location.pathname}${location.search}`}</output>
      </>
    );
  }
  await act(async () =>
    root.render(
      <MemoryRouter key={entry} initialEntries={[entry]}>
        <Probe />
      </MemoryRouter>
    )
  );
  await act(async () => undefined);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it("view=outcomes 不再回退到研究链列表", async () => {
  await render("/lab/research/chains?view=outcomes");

  expect(container.textContent).toContain("report-outcome-workbench");
  expect(container.textContent).not.toContain("chain-board");
});

it("legacy reports 视图继续渲染报告与成果工作台", async () => {
  await render("/lab/research/chains?view=reports");

  expect(container.textContent).toContain("report-outcome-workbench");
  expect(container.textContent).not.toContain("chain-board");
});

it("legacy project 视图回退到课题列表，不再渲染行政或权威 Project 列表", async () => {
  await render("/lab/research/chains?view=projects");

  expect(container.textContent).toContain("research-project-records");
  expect(container.textContent).not.toContain("project-list");
  expect(container.textContent).not.toContain("research.chains.views.projects");
});

it("课题视图保留创建科研项目入口，报告与成果视图不显示", async () => {
  await render("/lab/research/chains");
  const createButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "research.projects.create"
  );
  if (!createButton) throw new Error("创建科研项目入口未显示");
  expect(container.querySelector('output[aria-label="URL"]')?.textContent).toBe("/lab/research/chains");

  await act(async () => createButton.click());
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("research.projects.create_title");
  expect(container.querySelector('output[aria-label="URL"]')?.textContent).toBe("/lab/research/chains");

  await render("/lab/research/chains?view=reports");
  expect(
    Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "research.projects.create")
  ).toBe(false);
});

it("create=1 会打开创建弹窗并清理 URL", async () => {
  await render("/lab/research/chains?create=1");

  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("research.projects.create_title");
  expect(container.querySelector('output[aria-label="URL"]')?.textContent).toBe("/lab/research/chains");
});
