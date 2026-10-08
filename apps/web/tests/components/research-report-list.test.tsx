// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createReport: vi.fn(),
  fetchReportTemplates: vi.fn(),
  fetchReports: vi.fn(),
  fetchResearchProjects: vi.fn(),
  fetchOrgUnits: vi.fn(),
}));

const template = {
  id: "template-1",
  report_type: "WEEKLY",
  name: "Graphite weekly template",
  content_json: {},
  is_default: true,
  is_active: true,
  created_at: "2026-10-08T00:00:00Z",
  updated_at: "2026-10-08T00:00:00Z",
};

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "research.reports.create": "创建报告",
        "research.reports.template": "模板",
        "research.feedback.report_created.title": "报告已创建",
        "research.feedback.report_created.message": "请继续编辑正文。",
      })[key] ?? key,
    currentLocale: "zh-CN",
  }),
}));
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
  ResearchStatusBadge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/research/materials/topic-material-actions", () => ({
  ResearchTopicMaterialActions: () => null,
}));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    identity: { user: { org_units: [{ org_unit: "unit-1", is_primary: true }] } },
    reportLoader: false,
    reportPaginationByWorkspace: {},
    getReports: () => [],
    getOrgUnits: () => [],
    getResearchProjects: () => [],
    getReportTemplates: () => [template],
    templatesLoader: false,
    fetchReports: mocks.fetchReports,
    fetchResearchProjects: mocks.fetchResearchProjects,
    fetchOrgUnits: mocks.fetchOrgUnits,
    fetchReportTemplates: mocks.fetchReportTemplates,
    createReport: mocks.createReport,
  }),
}));

const { ResearchReportList } = await import("@/components/research/reports/report-list");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** Find a button by exact visible text. */
function button(label: string) {
  let target: HTMLButtonElement | null = null;
  for (const item of Array.from(container.querySelectorAll("button"))) {
    if (item.textContent === label) target = item;
  }
  if (!target) throw new Error(`未找到按钮：${label}`);
  return target;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.fetchReportTemplates.mockResolvedValue([template]);
  mocks.fetchReports.mockResolvedValue([]);
  mocks.fetchResearchProjects.mockResolvedValue([]);
  mocks.fetchOrgUnits.mockResolvedValue([]);
  mocks.createReport.mockResolvedValue({ id: "report-1" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it("报告创建弹窗按类型读取模板并携带模板 ID 导航", async () => {
  function Probe() {
    const location = useLocation();
    return (
      <>
        <ResearchReportList workspaceSlug="lab" />
        <output aria-label="URL">{location.pathname}</output>
      </>
    );
  }

  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/reports"]}>
        <Probe />
      </MemoryRouter>
    )
  );
  await act(async () => button("创建报告").click());
  expect(mocks.fetchReportTemplates).toHaveBeenCalledWith("lab", { report_type: "WEEKLY" });
  expect(container.textContent).toContain("Graphite weekly template");

  const select = container.querySelector<HTMLSelectElement>('select[aria-label="模板"]');
  if (!select) throw new Error("模板选择未显示");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, "template-1");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("创建报告").click());

  expect(mocks.createReport).toHaveBeenCalledWith("lab", {
    report_type: "WEEKLY",
    period_key: undefined,
    team_projects: [],
    template: "template-1",
  });
  expect(container.querySelector('output[aria-label="URL"]')?.textContent).toBe("/lab/research/reports/report-1");
});
