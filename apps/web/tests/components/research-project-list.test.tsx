// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TResearchProject } from "@/services/research/project.service";

const mocks = vi.hoisted(() => ({
  fetchResearchProjects: vi.fn(),
  fetchOrgUnits: vi.fn(),
  updateResearchProject: vi.fn(),
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
  getButtonStyling: () => "secondary-button",
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
vi.mock("@plane/ui", async () => ({
  ...(await vi.importActual("@plane/ui")),
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
    identity: {
      sections: { research_chain: true },
      user: { org_units: [{ org_unit: "unit-1", is_primary: true }] },
    },
    isWorkspaceAdmin: false,
    isResearchAdmin: false,
    projectLoader: false,
    projectPaginationByWorkspace: {},
    getResearchProjects: () => mocks.projects,
    getOrgUnits: () => [{ id: "unit-1", name: "材料课题组" }],
    fetchResearchProjects: mocks.fetchResearchProjects,
    fetchOrgUnits: mocks.fetchOrgUnits,
    updateResearchProject: mocks.updateResearchProject,
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
  mocks.updateResearchProject.mockResolvedValue(undefined);
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

it("项目档案行只保留一个删除入口且操作按打开和管理分组排列", async () => {
  mocks.projects = [
    {
      id: "project-1",
      name: "在研课题",
      identifier: "ACTIVE",
      archived_at: null,
      is_research_project: true,
      research: {
        owner: "user-1",
        workflow_status: "ACTIVE",
        research_type: "RESEARCH_PROJECT",
        chain_kind: "RESEARCH_CHAIN",
        chain_id: "chain-1",
      },
    },
  ] as TResearchProject[];

  await act(async () =>
    root.render(
      <MemoryRouter>
        <ResearchProjectList workspaceSlug="lab" currentUserId="user-1" />
      </MemoryRouter>
    )
  );

  const actionCell = [...container.querySelectorAll("td")].at(-1);
  if (!actionCell) throw new Error("操作列不存在");
  const controls = Array.from(actionCell.querySelectorAll("a, button"));
  const deleteControls = controls.filter((control) => {
    const label = control.getAttribute("aria-label") ?? control.getAttribute("title") ?? "";
    return label.toLowerCase().includes("delete");
  });

  expect(deleteControls).toHaveLength(1);
  expect(controls.map((control) => control.tagName)).toEqual(["A", "BUTTON", "BUTTON", "BUTTON"]);
  expect(controls[0]?.getAttribute("href")).toBe("/lab/research/chains/chain-1?tab=overview");
  expect(controls[0]?.textContent).toContain("research.projects.open_team_project");
  expect(controls[1]?.getAttribute("aria-label")).toBe("research.projects.edit：在研课题");
  expect(controls[2]?.getAttribute("aria-label")).toBe("research.projects.archive：在研课题");
  expect(controls[3]?.getAttribute("aria-label")).toBe("research.projects.delete：在研课题");
});

it("打开项目按研究链与旧培养项目选择现有主工作区", async () => {
  mocks.projects = [
    {
      id: "project-chain",
      name: "博士研究链",
      research: {
        owner: "user-1",
        workflow_status: "ACTIVE",
        research_type: "PHD",
        chain_kind: "RESEARCH_CHAIN",
        chain_id: "chain-1",
      },
    },
    {
      id: "project-legacy",
      name: "硕士培养项目",
      research: {
        owner: "user-1",
        workflow_status: "ACTIVE",
        research_type: "MASTER",
        chain_kind: "LEGACY_TRAINING",
      },
    },
    {
      id: "project-team",
      name: "团队项目",
      research: {
        owner: "user-1",
        workflow_status: "ACTIVE",
        research_type: "RESEARCH_PROJECT",
        chain_kind: "LEGACY_TRAINING",
      },
    },
  ] as TResearchProject[];

  await act(async () =>
    root.render(
      <MemoryRouter>
        <ResearchProjectList workspaceSlug="lab" currentUserId="user-1" />
      </MemoryRouter>
    )
  );

  const openLinks = [...container.querySelectorAll("a")].filter(
    (link) => link.textContent === "research.projects.open_team_project"
  );
  expect(openLinks.map((link) => link.getAttribute("href"))).toEqual([
    "/lab/research/chains/chain-1?tab=overview",
    "/lab/research/projects/project-legacy/stages",
    "/lab/research/projects/project-team/overview",
  ]);
});

it("负责人可从列表齿轮编辑项目信息并刷新当前筛选", async () => {
  const item = {
    id: "project-1",
    name: "旧科研课题",
    identifier: "OLD",
    archived_at: null,
    is_research_project: true,
    research: {
      owner: "user-1",
      org_unit: "unit-1",
      research_type: "RESEARCH_PROJECT",
      chain_kind: "RESEARCH_CHAIN",
      chain_visibility: "PRIVATE",
      workflow_status: "ACTIVE",
    },
  } as TResearchProject;
  mocks.projects = [item];
  mocks.updateResearchProject.mockResolvedValue({ ...item, name: "新科研课题" });
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/chains?view=projects&workflow_status=ACTIVE"]}>
        <ResearchProjectList workspaceSlug="lab" currentUserId="user-1" />
      </MemoryRouter>
    )
  );

  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="research.projects.edit：旧科研课题"]')?.click()
  );
  const dialog = container.querySelector('[role="dialog"]');
  expect(dialog?.textContent).toContain("research.projects.edit_title");
  const nameInput = [...container.querySelectorAll("label")]
    .find((label) => label.textContent?.includes("research.projects.fields.name"))
    ?.querySelector("input");
  expect(nameInput?.value).toBe("旧科研课题");

  await act(async () => {
    if (!nameInput) throw new Error("项目名称输入框不存在");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(nameInput, "新科研课题");
    nameInput.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
      .find((button) => button.textContent === "research.projects.save")
      ?.click()
  );

  expect(mocks.updateResearchProject).toHaveBeenCalledWith(
    "lab",
    "project-1",
    expect.objectContaining({ name: "新科研课题" })
  );
  expect(mocks.fetchResearchProjects).toHaveBeenLastCalledWith("lab", { per_page: "50", workflow_status: "ACTIVE" });
});

it("非负责人且非科研管理员看不到编辑齿轮", async () => {
  mocks.projects = [
    {
      id: "project-1",
      name: "他人课题",
      identifier: "OTHER",
      archived_at: null,
      is_research_project: true,
      research: { owner: "user-2", workflow_status: "ACTIVE", research_type: "RESEARCH_PROJECT" },
    },
  ] as TResearchProject[];
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ResearchProjectList workspaceSlug="lab" currentUserId="user-1" />
      </MemoryRouter>
    )
  );

  expect(container.querySelector('[aria-label^="research.projects.edit："]')).toBeNull();
  const actionCell = [...container.querySelectorAll("td")].at(-1);
  expect(actionCell?.querySelectorAll("button").length).toBe(0);
  expect(actionCell?.querySelectorAll("a").length).toBe(1);
});

it("归档项目保留编辑入口而已删除项目隐藏", async () => {
  mocks.projects = [
    {
      id: "project-archived",
      name: "归档课题",
      identifier: "ARCH",
      archived_at: null,
      is_research_project: true,
      research: { owner: "user-1", workflow_status: "ARCHIVED", research_type: "RESEARCH_PROJECT" },
    },
    {
      id: "project-deleted",
      name: "删除课题",
      identifier: "DEL",
      archived_at: null,
      is_research_project: true,
      research: { owner: "user-1", workflow_status: "DELETED", research_type: "RESEARCH_PROJECT" },
    },
  ] as TResearchProject[];
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/chains?view=projects&workflow_status=DELETED"]}>
        <ResearchProjectList workspaceSlug="lab" currentUserId="user-1" />
      </MemoryRouter>
    )
  );

  expect(container.querySelector('[aria-label="research.projects.edit：归档课题"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="research.projects.archive：归档课题"]')).toBeNull();
  expect(container.querySelector('[aria-label="research.projects.restore：归档课题"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="research.projects.delete：归档课题"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="research.projects.edit：删除课题"]')).toBeNull();
  expect(container.querySelector('[aria-label="research.projects.delete：删除课题"]')).toBeNull();
  expect(container.querySelector('[aria-label="research.projects.restore：删除课题"]')).not.toBeNull();
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
