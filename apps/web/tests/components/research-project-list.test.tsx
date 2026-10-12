// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TResearchProject } from "@/services/research/project.service";

const mocks = vi.hoisted(() => ({
  fetchResearchProjects: vi.fn(),
  fetchOrgUnits: vi.fn(),
  deleteResearchProject: vi.fn(),
  restoreResearchProject: vi.fn(),
  archiveResearchProject: vi.fn(),
  projects: [] as TResearchProject[],
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useParams: () => ({}) };
});
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key, currentLocale: "zh-CN" }) }));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@plane/propel/table", () => ({
  Table: ({ children }: { children: React.ReactNode }) => <table>{children}</table>,
  TableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
  TableCell: ({ children }: { children: React.ReactNode }) => <td>{children}</td>,
  TableHead: ({ children }: { children: React.ReactNode }) => <th>{children}</th>,
  TableHeader: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
  TableRow: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
}));
vi.mock("@plane/propel/toast", () => ({ TOAST_TYPE: { SUCCESS: "SUCCESS" }, setToast: vi.fn() }));
vi.mock("@plane/ui", () => ({
  AlertModalCore: ({
    isOpen,
    content,
    handleClose,
    handleSubmit,
    isSubmitting,
    primaryButtonText,
  }: {
    isOpen: boolean;
    content: React.ReactNode;
    handleClose: () => void;
    handleSubmit: () => void;
    isSubmitting: boolean;
    primaryButtonText: { default: string };
  }) =>
    isOpen ? (
      <div role="dialog">
        {content}
        <button onClick={handleClose}>取消</button>
        <button onClick={handleSubmit} disabled={isSubmitting}>
          {primaryButtonText.default}
        </button>
      </div>
    ) : null,
  EModalPosition: { CENTER: "center" },
  EModalWidth: { LG: "lg" },
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  ModalCore: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}));
vi.mock("@/components/research/common/browse-filters", () => ({ ResearchBrowseFilters: () => null }));
vi.mock("@/components/research/common/error-messages", () => ({ getResearchErrorKey: () => "error" }));
vi.mock("@/components/research/common/research-data-surface", () => ({
  ResearchFilterChips: () => null,
  ResearchFilterToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResearchListSurface: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResearchTableSurface: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/research/common/research-list-state", () => ({ ResearchListState: () => null }));
vi.mock("@/components/research/common/research-status-badge", () => ({
  ResearchStatusBadge: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    identity: { user: { org_units: [{ org_unit: "unit-1", is_primary: true }] } },
    isWorkspaceAdmin: false,
    projectLoader: false,
    projectPaginationByWorkspace: {},
    getResearchProjects: () => mocks.projects,
    getOrgUnits: () => [{ id: "unit-1", name: "材料课题组" }],
    fetchResearchProjects: mocks.fetchResearchProjects,
    fetchOrgUnits: mocks.fetchOrgUnits,
    deleteResearchProject: mocks.deleteResearchProject,
    restoreResearchProject: mocks.restoreResearchProject,
    archiveResearchProject: mocks.archiveResearchProject,
  }),
}));

const { ResearchProjectList } = await import("@/components/research/projects/research-project-list");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  mocks.projects = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.fetchResearchProjects.mockResolvedValue([]);
  mocks.fetchOrgUnits.mockResolvedValue([]);
  mocks.deleteResearchProject.mockResolvedValue(undefined);
  mocks.restoreResearchProject.mockResolvedValue(undefined);
  mocks.archiveResearchProject.mockResolvedValue(undefined);
});

it("旧项目列表提供确认删除，并在成功后刷新当前筛选", async () => {
  mocks.projects = [
    {
      id: "project-1",
      name: "旧科研课题",
      identifier: "OLD",
      archived_at: null,
      is_research_project: true,
      research: { owner: "user-1", workflow_status: "ACTIVE", research_type: "RESEARCH_PROJECT" },
    },
  ] as TResearchProject[];
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/projects?workflow_status=ACTIVE"]}>
        <ResearchProjectList workspaceSlug="lab" currentUserId="user-1" />
      </MemoryRouter>
    )
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="research.projects.delete：旧科研课题"]')?.click()
  );
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(mocks.deleteResearchProject).not.toHaveBeenCalled();
  const confirm = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
    (button) => button.textContent === "research.projects.delete"
  );
  await act(async () => confirm?.click());
  expect(mocks.deleteResearchProject).toHaveBeenCalledWith("lab", "project-1");
  expect(mocks.fetchResearchProjects).toHaveBeenLastCalledWith("lab", { per_page: "50", workflow_status: "ACTIVE" });
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it("工作台统一的 create=1 参数会自动打开项目创建弹窗并清理 URL", async () => {
  function Probe() {
    const location = useLocation();
    return (
      <>
        <ResearchProjectList workspaceSlug="lab" currentUserId="user-1" />
        <output aria-label="URL">{`${location.pathname}${location.search}`}</output>
      </>
    );
  }

  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/chains?view=projects&create=1"]}>
        <Probe />
      </MemoryRouter>
    )
  );
  await act(async () => undefined);

  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("research.projects.create_title");
  expect(container.querySelector('output[aria-label="URL"]')?.textContent).toBe("/lab/research/chains?view=projects");
});

it("项目列表回放共同浏览参数并只携带项目领域参数", async () => {
  const search =
    "?scope=owned&owner=uuid&q=graphite&date_from=2026-10-01&date_to=2026-10-08&org_unit=org-1&cursor=cursor-1&workflow_status=ACTIVE&research_type=RESEARCH_PROJECT";
  function Probe() {
    const location = useLocation();
    return (
      <>
        <ResearchProjectList workspaceSlug="lab" currentUserId="user-1" />
        <output aria-label="URL">{`${location.pathname}${location.search}`}</output>
      </>
    );
  }

  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[`/lab/research/chains${search}`]}>
        <Probe />
      </MemoryRouter>
    )
  );
  await act(async () => undefined);

  expect(container.querySelector('output[aria-label="URL"]')?.textContent).toBe(`/lab/research/chains${search}`);
  expect(mocks.fetchResearchProjects).toHaveBeenCalledWith("lab", {
    per_page: "50",
    scope: "owned",
    owner: "uuid",
    q: "graphite",
    date_from: "2026-10-01",
    date_to: "2026-10-08",
    org_unit: "org-1",
    cursor: "cursor-1",
    workflow_status: "ACTIVE",
    research_type: "RESEARCH_PROJECT",
  });
  expect(mocks.fetchResearchProjects.mock.calls[0]?.[1]).not.toHaveProperty("status");
  expect(mocks.fetchResearchProjects.mock.calls[0]?.[1]).not.toHaveProperty("report_type");
});
