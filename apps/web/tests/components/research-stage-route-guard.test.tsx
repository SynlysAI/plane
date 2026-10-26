// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TResearchProject } from "@/services/research/project.service";

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  projectNav: vi.fn(),
  routeParams: { current: {} as Record<string, string | undefined> },
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useParams: () => mocks.routeParams.current };
});
vi.mock("@/services/research/project.service", () => ({
  ResearchProjectService: class {
    getProject = mocks.getProject;
  },
}));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/ui", () => ({ Spinner: () => <span role="status">loading</span> }));
vi.mock("@/components/research/common/error-messages", () => ({ getResearchErrorKey: () => "error" }));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("@/components/research/common/research-page-shell", () => ({
  ResearchPageShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/research/common/research-back-link", () => ({
  ResearchBackLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/research/navigation/research-project-nav", () => ({
  ResearchProjectNav: mocks.projectNav,
}));
vi.mock("@/components/research/stages/stage-overview", () => ({
  StageOverview: () => <output>stage-overview</output>,
}));

const { default: StageListPage } =
  await import("../../app/(all)/[workspaceSlug]/(projects)/research/projects/[projectId]/stages/page");
const { default: StageDetailPage } =
  await import("../../app/(all)/[workspaceSlug]/(projects)/research/projects/[projectId]/stages/[stageCode]/page");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** 渲染阶段路由，并输出导航后的最终地址。 */
async function renderRoute(page: React.ReactElement, params: Record<string, string>) {
  mocks.routeParams.current = params;
  function Probe() {
    const location = useLocation();
    return (
      <>
        {page}
        <output aria-label="location">{`${location.pathname}${location.search}`}</output>
      </>
    );
  }
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/projects/project-1/stages"]}>
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
  mocks.getProject.mockReset();
  mocks.projectNav.mockReset();
  mocks.projectNav.mockImplementation(() => <nav>project-nav</nav>);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("研究链项目访问旧阶段深链时重定向到课题概览", async () => {
  mocks.getProject.mockResolvedValue({
    id: "project-1",
    research: { chain_kind: "RESEARCH_CHAIN", chain_id: "chain-1" },
  } as TResearchProject);

  await renderRoute(<StageListPage />, { workspaceSlug: "lab", projectId: "project-1" });

  expect(mocks.getProject).toHaveBeenCalledWith("lab", "project-1");
  expect(container.querySelector('output[aria-label="location"]')?.textContent).toBe(
    "/lab/research/chains/chain-1?tab=overview"
  );
  expect(container.textContent).not.toContain("stage-overview");
  expect(mocks.projectNav).not.toHaveBeenCalled();
});

it("旧培养项目继续渲染四阶段工作台且外层不重复项目导航", async () => {
  mocks.getProject.mockResolvedValue({
    id: "project-1",
    research: { chain_kind: "LEGACY_TRAINING" },
  } as TResearchProject);

  await renderRoute(<StageListPage />, { workspaceSlug: "lab", projectId: "project-1" });

  expect(container.querySelector('output[aria-label="location"]')?.textContent).toBe(
    "/lab/research/projects/project-1/stages"
  );
  expect(container.textContent).toContain("stage-overview");
  expect(mocks.projectNav).not.toHaveBeenCalled();
});

it("阶段详情深链同样先经过研究链路由守卫", async () => {
  mocks.getProject.mockResolvedValue({
    id: "project-1",
    research: { chain_kind: "RESEARCH_CHAIN", chain_id: "chain-1" },
  } as TResearchProject);

  await renderRoute(<StageDetailPage />, {
    workspaceSlug: "lab",
    projectId: "project-1",
    stageCode: "opening",
  });

  expect(container.querySelector('output[aria-label="location"]')?.textContent).toBe(
    "/lab/research/chains/chain-1?tab=overview"
  );
  expect(container.textContent).not.toContain("stage-overview");
});
