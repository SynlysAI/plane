// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TProject } from "@plane/types";

const mocks = vi.hoisted(() => ({
  projects: {} as Record<string, TProject>,
}));

vi.mock("mobx-react", () => ({
  enableStaticRendering: () => undefined,
  observer: (component: unknown) => component,
}));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/constants", () => ({
  EUserPermissions: { ADMIN: 20, MEMBER: 15 },
  EUserPermissionsLevel: { WORKSPACE: "WORKSPACE" },
}));
vi.mock("@plane/utils", () => ({ calculateTotalFilters: () => 0 }));
vi.mock("@plane/propel/empty-state", () => ({ EmptyStateDetailed: () => <div>empty-state</div> }));
vi.mock("@plane/ui", () => ({
  ContentWrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/loader/projects-loader", () => ({ ProjectsLoader: () => <div>projects-loader</div> }));
vi.mock("@/components/project/card", () => ({
  ProjectCard: ({ project }: { project: TProject }) => <div data-testid="project-card">{project.name}</div>,
}));
vi.mock("@/hooks/store/use-command-palette", () => ({
  useCommandPalette: () => ({ toggleCreateProjectModal: vi.fn() }),
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({
    loader: undefined,
    fetchStatus: "complete",
    workspaceProjectIds: Object.keys(mocks.projects),
    filteredProjectIds: Object.keys(mocks.projects),
    getProjectById: (id: string) => mocks.projects[id],
  }),
}));
vi.mock("@/hooks/store/use-project-filter", () => ({
  useProjectFilter: () => ({ currentWorkspaceDisplayFilters: {}, currentWorkspaceFilters: {} }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({ allowPermissions: () => true }),
}));

const { ProjectCardList } = await import("@/components/project/card-list");

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

function makeProject(id: string, organizationId: string | null): TProject {
  return { id, name: id, administrative_organization: organizationId } as TProject;
}

const organizations = [
  { id: "org-12dc", name: "12dc", is_default: false },
  { id: "org-public", name: "公共", is_default: true },
];

it("renders project sections ordered by organization with counts", async () => {
  mocks.projects = {
    "public-1": makeProject("public-1", "org-public"),
    "12dc-1": makeProject("12dc-1", "org-12dc"),
    "legacy-1": makeProject("legacy-1", null),
  };
  await act(async () => root.render(<ProjectCardList organizations={organizations} />));

  const headers = [...container.querySelectorAll("h3")].map((header) => header.textContent);
  expect(headers).toEqual(["公共", "12dc", "未分组"]);
  const counts = [...container.querySelectorAll("section > div > span")].map((item) => item.textContent);
  expect(counts).toEqual(["1", "1", "1"]);
  const cards = [...container.querySelectorAll('[data-testid="project-card"]')].map((card) => card.textContent);
  expect(cards).toEqual(["public-1", "12dc-1", "legacy-1"]);
});

it("keeps the flat grid when organization data is unavailable", async () => {
  mocks.projects = { "public-1": makeProject("public-1", "org-public") };
  await act(async () => root.render(<ProjectCardList />));

  expect(container.querySelector("h3")).toBeNull();
  expect([...container.querySelectorAll('[data-testid="project-card"]')].map((card) => card.textContent)).toEqual([
    "public-1",
  ]);
});
