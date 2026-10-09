// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
vi.mock("@/components/research/projects/research-project-list", () => ({
  ResearchProjectList: () => <output>project-list</output>,
}));
vi.mock("@/components/research/reports/report-list", () => ({
  ResearchReportList: () => <output>report-outcome-workbench</output>,
}));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    isIaV2Enabled: true,
    isWorkspaceAdmin: true,
    identity: { user: { org_units: [] } },
  }),
}));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: { id: "user-1" } }) }));

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

it("课题与项目视图共享一个创建科研项目入口，报告与成果视图不显示", async () => {
  await render("/lab/research/chains");
  const createButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "research.projects.create"
  );
  if (!createButton) throw new Error("创建科研项目入口未显示");
  expect(container.querySelector('output[aria-label="URL"]')?.textContent).toBe("/lab/research/chains");

  await act(async () => createButton.click());
  expect(container.querySelector('output[aria-label="URL"]')?.textContent).toBe(
    "/lab/research/chains?view=projects&create=1"
  );
  expect(container.textContent).toContain("project-list");

  await render("/lab/research/chains?view=reports");
  expect(
    Array.from(container.querySelectorAll("button")).some((button) => button.textContent === "research.projects.create")
  ).toBe(false);
});
