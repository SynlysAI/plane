// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchResearchProjects: vi.fn(),
  fetchOrgUnits: vi.fn(),
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
  AlertModalCore: () => null,
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
    getResearchProjects: () => [],
    getOrgUnits: () => [{ id: "unit-1", name: "材料课题组" }],
    fetchResearchProjects: mocks.fetchResearchProjects,
    fetchOrgUnits: mocks.fetchOrgUnits,
  }),
}));

const { ResearchProjectList } = await import("@/components/research/projects/research-project-list");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.fetchResearchProjects.mockResolvedValue([]);
  mocks.fetchOrgUnits.mockResolvedValue([]);
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
