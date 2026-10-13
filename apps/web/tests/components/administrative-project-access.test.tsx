// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IProject } from "@plane/types";
import { projectCanBeJoined } from "@/store/project/project-visibility";

const mocks = vi.hoisted(() => ({
  details: { data: undefined as unknown, error: undefined as unknown, isLoading: false },
  hasProjectPermission: true,
  isWorkspaceAdmin: true,
  join: vi.fn().mockResolvedValue(undefined),
  push: vi.fn(),
  revalidateDetails: vi.fn().mockResolvedValue(undefined),
  resourceKeys: [] as unknown[],
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/propel/empty-state", () => ({
  EmptyStateDetailed: ({
    title,
    description,
    actions = [],
  }: {
    title: string;
    description: string;
    actions?: { label: string; onClick: () => void; disabled?: boolean }[];
  }) => (
    <section>
      <h2>{title}</h2>
      <p>{description}</p>
      {actions.map((action) => (
        <button key={action.label} onClick={action.onClick} disabled={action.disabled}>
          {action.label}
        </button>
      ))}
    </section>
  ),
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock("@plane/ui", () => ({
  EModalPosition: { CENTER: "center" },
  EModalWidth: { XL: "xl" },
  ModalCore: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div>{children}</div> : null,
}));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: mocks.push }) }));
vi.mock("@plane/constants", () => ({
  EUserPermissions: { ADMIN: 20, MEMBER: 15, GUEST: 5 },
  EUserPermissionsLevel: { PROJECT: "project", WORKSPACE: "workspace" },
  PROJECT_DETAILS: () => "details",
  PROJECT_ME_INFORMATION: () => "me",
  ...Object.fromEntries(
    [
      "PROJECT_LABELS",
      "PROJECT_MEMBERS",
      "PROJECT_MEMBER_PREFERENCES",
      "PROJECT_STATES",
      "PROJECT_ESTIMATES",
      "PROJECT_ALL_CYCLES",
      "PROJECT_MODULES",
      "PROJECT_VIEWS",
      "PROJECT_INTAKE_STATE",
    ].map((name) => [name, () => name])
  ),
}));
vi.mock("@plane/types", () => ({ GANTT_TIMELINE_TYPE: { MODULE: "module" } }));
vi.mock("swr", () => ({
  default: (key: unknown) => {
    mocks.resourceKeys.push(key);
    return key === "details" ? { ...mocks.details, mutate: mocks.revalidateDetails } : {};
  },
}));
vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: { id: "user" } }),
  useUserPermissions: () => ({
    joinProject: mocks.join,
    fetchUserProjectInfo: vi.fn(),
    getProjectRoleByWorkspaceSlugAndProjectId: () => 20,
    allowPermissions: (_roles: unknown, level: string) =>
      level === "workspace" ? mocks.isWorkspaceAdmin : mocks.hasProjectPermission,
  }),
}));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ fetchProjectDetails: vi.fn() }) }));
vi.mock("@/hooks/store/estimates", () => ({ useProjectEstimates: () => ({ getProjectEstimates: vi.fn() }) }));
vi.mock("@/hooks/store/use-cycle", () => ({ useCycle: () => ({ fetchAllCycles: vi.fn() }) }));
vi.mock("@/hooks/store/use-label", () => ({ useLabel: () => ({ fetchProjectLabels: vi.fn() }) }));
vi.mock("@/hooks/store/use-module", () => ({
  useModule: () => ({ fetchModulesSlim: vi.fn(), fetchModules: vi.fn() }),
}));
vi.mock("@/hooks/store/use-project-view", () => ({ useProjectView: () => ({ fetchViews: vi.fn() }) }));
vi.mock("@/hooks/store/use-project-state", () => ({
  useProjectState: () => ({ fetchProjectStates: vi.fn(), fetchProjectIntakeState: vi.fn() }),
}));
vi.mock("@/hooks/use-timeline-chart", () => ({ useTimeLineChart: () => ({ initGantt: vi.fn() }) }));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({ project: { fetchProjectMembers: vi.fn(), fetchProjectUserProperties: vi.fn() } }),
}));

const { ProjectAuthWrapper } = await import("@/layouts/auth-layout/project-wrapper");
const { JoinProjectModal } = await import("@/components/project/join-project-modal");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.details = { data: undefined, error: undefined, isLoading: false };
  mocks.hasProjectPermission = true;
  mocks.isWorkspaceAdmin = true;
  mocks.resourceKeys = [];
  mocks.revalidateDetails.mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it.each([false, undefined])(
  "does not offer self-join for administrative or unclassified projects (%s)",
  async (flag) => {
    const project = { id: "administrative", name: "Administrative", is_research_project: flag } as IProject;
    expect(projectCanBeJoined(project)).toBe(false);
    await act(async () =>
      root.render(<JoinProjectModal isOpen workspaceSlug="lab" project={project} handleClose={vi.fn()} />)
    );
    expect(container.querySelector("button")).toBeNull();
    expect(mocks.join).not.toHaveBeenCalled();
  }
);

it("preserves joining a research project", async () => {
  const project = { id: "research", name: "Research", is_research_project: true } as IProject;
  await act(async () =>
    root.render(<JoinProjectModal isOpen workspaceSlug="lab" project={project} handleClose={vi.fn()} />)
  );
  const button = [...container.querySelectorAll("button")].find((element) => element.textContent === "Join Project");
  await act(async () => button?.click());
  expect(mocks.join).toHaveBeenCalledWith("lab", "research");
  expect(mocks.push).toHaveBeenCalledWith("/lab/projects/research/issues");
});

it("does not allow archived or already joined research projects to self-join", () => {
  expect(projectCanBeJoined({ is_research_project: true, archived_at: "2026-10-12" })).toBe(false);
  expect(projectCanBeJoined({ is_research_project: true, member_role: 5 })).toBe(false);
});

it("uses a membership denial over stale cached administrator permissions", async () => {
  mocks.details = {
    data: { name: "Cached confidential project" },
    error: { status: 403, data: { code: "PROJECT_MEMBERSHIP_REQUIRED" } },
    isLoading: false,
  };
  await act(async () =>
    root.render(
      <ProjectAuthWrapper workspaceSlug="lab" projectId="administrative">
        <p>Confidential tasks</p>
      </ProjectAuthWrapper>
    )
  );
  expect(container.textContent).toContain("restricted_description");
  expect(container.textContent).not.toContain("Confidential tasks");
  expect(container.querySelector("button")).toBeNull();
  expect(mocks.resourceKeys.filter((key) => key !== null)).toEqual(["details", "me"]);
});

it("allows a default manager with a successful project response to enter", async () => {
  mocks.details.data = { id: "administrative", member_role: 20 };
  await act(async () =>
    root.render(
      <ProjectAuthWrapper workspaceSlug="lab" projectId="administrative">
        <p>Authorized tasks</p>
      </ProjectAuthWrapper>
    )
  );
  expect(container.textContent).toBe("Authorized tasks");
  expect(mocks.resourceKeys).toContain("PROJECT_MEMBERS");
});

it.each([409, 403])("preserves the research join screen for status %s", async (status) => {
  mocks.hasProjectPermission = false;
  mocks.details.error = { status, data: {} };
  await act(async () =>
    root.render(
      <ProjectAuthWrapper workspaceSlug="lab" projectId="research">
        <p>Research tasks</p>
      </ProjectAuthWrapper>
    )
  );
  expect(container.textContent).toContain("join_description");
  await act(async () => container.querySelector("button")?.click());
  expect(mocks.join).toHaveBeenCalledWith("lab", "research");
  expect(mocks.revalidateDetails).toHaveBeenCalledOnce();
});

it("clears the research access error after a successful join", async () => {
  mocks.hasProjectPermission = false;
  mocks.details.error = { status: 409, data: {} };
  mocks.revalidateDetails.mockImplementationOnce(async () => {
    mocks.details = { data: { id: "research", member_role: 15 }, error: undefined, isLoading: false };
    mocks.hasProjectPermission = true;
  });
  const content = (
    <ProjectAuthWrapper workspaceSlug="lab" projectId="research">
      <p>Research tasks</p>
    </ProjectAuthWrapper>
  );
  await act(async () => root.render(content));
  await act(async () => container.querySelector("button")?.click());
  await act(async () => root.render(<>{content}</>));
  expect(container.textContent).toContain("Research tasks");
  expect(container.textContent).not.toContain("join_description");
});

it("shows ordinary users a restriction for a private project", async () => {
  mocks.hasProjectPermission = false;
  mocks.isWorkspaceAdmin = false;
  mocks.details.error = { status: 403, data: {} };
  await act(async () =>
    root.render(
      <ProjectAuthWrapper workspaceSlug="lab" projectId="project">
        <p>Tasks</p>
      </ProjectAuthWrapper>
    )
  );
  expect(container.textContent).toContain("restricted_description");
  expect(container.querySelector("button")).toBeNull();
});
