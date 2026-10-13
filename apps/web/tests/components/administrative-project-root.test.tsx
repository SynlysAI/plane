// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TProject } from "@plane/types";

const mocks = vi.hoisted(() => ({
  cardProps: null as { totalProjectIds?: string[]; filteredProjectIds?: string[] } | null,
  pathname: "/lab/projects",
  research: {
    isEnabled: true,
    isIaV2Enabled: true,
  },
  projectStore: {
    loader: "loaded",
    fetchStatus: "complete",
    totalProjectIds: ["research-1", "admin-1", "research-2", "admin-2"],
    filteredProjectIds: ["research-1", "admin-1", "admin-2"],
    getProjectById: (id: string) =>
      ({
        id,
        is_research_project: id.startsWith("research-"),
      }) as TProject,
  },
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "lab" }),
  usePathname: () => mocks.pathname,
}));
vi.mock("@/components/core/page-title", () => ({ PageHead: () => null }));
vi.mock("../../core/components/project/card-list", () => ({
  ProjectCardList: (props: { totalProjectIds?: string[]; filteredProjectIds?: string[] }) => {
    mocks.cardProps = props;
    return <output>project-card-list</output>;
  },
}));
vi.mock("@/components/project/applied-filters", () => ({ ProjectAppliedFiltersList: () => null }));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => mocks.projectStore }));
vi.mock("@/hooks/store/use-project-filter", () => ({
  useProjectFilter: () => ({
    currentWorkspaceFilters: {},
    currentWorkspaceAppliedDisplayFilters: [],
    clearAllFilters: vi.fn(),
    clearAllAppliedDisplayFilters: vi.fn(),
    updateFilters: vi.fn(),
    updateDisplayFilters: vi.fn(),
  }),
}));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => mocks.research }));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => ({ currentWorkspace: { id: "workspace-1" } }) }));

const { ProjectRoot } = await import("@/components/project/root");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.cardProps = null;
  mocks.pathname = "/lab/projects";
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("hides research-backed authority projects from the administrative project tab", async () => {
  await act(async () => root.render(<ProjectRoot />));

  expect(mocks.cardProps?.totalProjectIds).toEqual(["admin-1", "admin-2"]);
  expect(mocks.cardProps?.filteredProjectIds).toEqual(["admin-1", "admin-2"]);
});

it("keeps the administrative scope when IA v2 is disabled", async () => {
  mocks.research.isIaV2Enabled = false;
  await act(async () => root.render(<ProjectRoot />));
  mocks.research.isIaV2Enabled = true;

  expect(mocks.cardProps?.totalProjectIds).toEqual(["admin-1", "admin-2"]);
  expect(mocks.cardProps?.filteredProjectIds).toEqual(["admin-1", "admin-2"]);
});

it("keeps research projects out of the archive entrance", async () => {
  mocks.pathname = "/lab/archives";
  await act(async () => root.render(<ProjectRoot />));
  expect(mocks.cardProps?.totalProjectIds).toEqual(["admin-1", "admin-2"]);
  expect(mocks.cardProps?.filteredProjectIds).toEqual(["admin-1", "admin-2"]);
});
