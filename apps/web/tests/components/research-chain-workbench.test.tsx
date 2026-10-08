// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/propel/tab-navigation", () => ({
  TabNavigationList: ({ children }: { children: React.ReactNode }) => <nav>{children}</nav>,
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
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => ({ isIaV2Enabled: true }) }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: { id: "user-1" } }) }));

const { ResearchChainWorkbench } = await import("@/components/research/chains/research-chain-workbench");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** 渲染 IA v2 研究链工作台。 */
async function render(entry: string) {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <ResearchChainWorkbench workspaceSlug="lab" />
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
