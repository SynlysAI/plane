// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const routeParams = vi.hoisted(() => ({ current: {} as Record<string, string | undefined> }));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("react-router", () => ({ useParams: () => routeParams.current }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("lucide-react", () => ({ ChevronLeft: () => <span aria-hidden="true">←</span> }));
vi.mock("@plane/constants", () => ({
  RESEARCH_PROJECT_NAVIGATION_ITEMS: [
    { key: "stages", labelKey: "research.nav.stages", path: "stages", section: "stages" },
  ],
}));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/lab/research/projects/project-1/stages" }));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({ identity: { sections: { stages: true } } }),
}));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("@/components/research/common/research-page-shell", () => ({
  ResearchPageShell: ({ breadcrumbs, children }: { breadcrumbs?: React.ReactNode; children: React.ReactNode }) => (
    <main>
      {breadcrumbs}
      {children}
    </main>
  ),
}));
vi.mock("@/components/research/reports/report-detail", () => ({ ResearchReportDetail: () => <p>report-detail</p> }));
vi.mock("@/components/research/chains/research-chain-detail", () => ({
  ResearchChainDetail: () => <p>chain-detail</p>,
}));
vi.mock("@/components/research/stages/stage-overview", () => ({ StageOverview: () => <p>stage-overview</p> }));
vi.mock("@/components/research/stages/stage-material-detail", () => ({
  StageMaterialDetail: () => <p>material-detail</p>,
}));
vi.mock("@/components/research/agent/research-agent-plugin", () => ({
  ResearchAgentPlugin: () => <p>agent-plugin</p>,
}));

const { default: ReportDetailPage } =
  await import("../../app/(all)/[workspaceSlug]/(projects)/research/reports/[reportId]/page");
const { default: ChainDetailPage } =
  await import("../../app/(all)/[workspaceSlug]/(projects)/research/chains/[chainId]/page");
const { default: StageDetailPage } =
  await import("../../app/(all)/[workspaceSlug]/(projects)/research/projects/[projectId]/stages/[stageCode]/page");
const { default: MaterialDetailPage } =
  await import("../../app/(all)/[workspaceSlug]/(projects)/research/projects/[projectId]/stages/[stageCode]/materials/[materialId]/page");
const { default: AgentDetailPage } =
  await import("../../app/(all)/[workspaceSlug]/(projects)/research/chains/[chainId]/nodes/[nodeId]/agent/page");
const { ResearchProjectNav } = await import("@/components/research/navigation/research-project-nav");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** Render one detail route with parameters matching its URL shape. */
async function renderPage(component: React.ReactElement, params: Record<string, string>) {
  routeParams.current = params;
  await act(async () => root.render(component));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("renders one nearest-list back link on every standalone research detail page", async () => {
  await renderPage(<ReportDetailPage />, { workspaceSlug: "lab", reportId: "report-1" });
  expect(container.querySelector('a[href="/lab/research/reports"]')?.textContent).toContain("返回报告列表");

  await renderPage(<ChainDetailPage />, { workspaceSlug: "lab", chainId: "chain-1" });
  expect(container.querySelector('a[href="/lab/research/chains"]')?.textContent).toContain("返回课题列表");

  await renderPage(<StageDetailPage />, { workspaceSlug: "lab", projectId: "project-1", stageCode: "opening" });
  expect(container.querySelector('a[href="/lab/research/projects/project-1/stages"]')?.textContent).toContain(
    "返回科研阶段"
  );

  await renderPage(<MaterialDetailPage />, {
    workspaceSlug: "lab",
    projectId: "project-1",
    stageCode: "opening",
    materialId: "material-1",
  });
  expect(container.querySelector('a[href="/lab/research/projects/project-1/stages/opening"]')?.textContent).toContain(
    "返回阶段详情"
  );

  await renderPage(<AgentDetailPage />, { workspaceSlug: "lab", chainId: "chain-1", nodeId: "node-1" });
  expect(container.querySelector('a[href="/lab/research/chains/chain-1"]')?.textContent).toContain("返回课题详情");
});

it("keeps only the closest project-list entry in project scoped navigation", async () => {
  routeParams.current = { workspaceSlug: "lab", projectId: "project-1" };
  await act(async () => root.render(<ResearchProjectNav workspaceSlug="lab" projectId="project-1" />));

  const researchLinks = Array.from(container.querySelectorAll("a")).filter((link) =>
    link.getAttribute("href")?.startsWith("/lab/research")
  );
  expect(researchLinks.map((link) => link.getAttribute("href"))).toEqual([
    "/lab/research/projects",
    "/lab/research/projects/project-1/stages",
  ]);
  expect(container.textContent).not.toContain("返回科研总览");
});
