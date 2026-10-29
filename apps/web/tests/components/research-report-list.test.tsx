// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createReport: vi.fn(),
  checkReportPeriod: vi.fn(),
  getReports: vi.fn(),
  restoreReport: vi.fn(),
  fetchReportTemplateOptions: vi.fn(),
  fetchReports: vi.fn(),
  fetchResearchProjects: vi.fn(),
  fetchOrgUnits: vi.fn(),
  browseFilters: vi.fn(),
  setToast: vi.fn(),
  copyTextToClipboard: vi.fn(),
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
let activeTemplate = { ...template };

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, string | number> = {}) => {
      const translation =
        {
          "research.reports.create": "创建报告",
          "research.reports.deleted_title": "已删除报告",
          "research.reports.deleted_status": "已删除",
          "research.reports.restore": "恢复",
          "research.reports.backfill": "补交",
          "research.reports.template": "模板",
          "research.home_workbench.by_week": "按周",
          "research.home_workbench.by_month": "按月",
          "research.common.open": "打开",
          "research.common.copy_share": "复制",
          "research.common.copy_share_aria": "复制分享链接：{title}",
          "research.report_types.weekly": "周报",
          "research.report_types.monthly": "月报",
          "common.loading": "检查周期中…",
          "research.errors.report_period_conflict": "该周期已有报告。",
          "research.feedback.report_created.title": "报告已创建",
          "research.feedback.report_created.message": "请继续编辑正文。",
          "research.feedback.report_restored.title": "报告已恢复",
          "research.feedback.report_restored.message": "正在打开报告详情。",
          "research.reports.columns.read_state": "已读状态",
          "research.reports.read.waiting": "待阅读",
          "research.reports.read.read_pending_review": "已读 · 待审阅",
          "research.report_visibility.unit_confidential": "本组（保密）",
        }[key] ?? key;
      return Object.entries(values).reduce(
        (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
        translation
      );
    },
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ loading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
    <button {...props} />
  ),
}));
vi.mock("@plane/propel/table", () => ({
  Table: ({ children }: { children: React.ReactNode }) => <table>{children}</table>,
  TableBody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
  TableCell: ({ children }: { children: React.ReactNode }) => <td>{children}</td>,
  TableHead: ({ children }: { children: React.ReactNode }) => <th>{children}</th>,
  TableHeader: ({ children }: { children: React.ReactNode }) => <thead>{children}</thead>,
  TableRow: ({ children }: { children: React.ReactNode }) => <tr>{children}</tr>,
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "SUCCESS", ERROR: "ERROR" },
  setToast: mocks.setToast,
}));
vi.mock("@plane/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@plane/utils")>()),
  copyTextToClipboard: mocks.copyTextToClipboard,
}));
vi.mock("@plane/propel/calendar", () => ({
  Calendar: ({ onSelect }: { onSelect: (date: Date | undefined) => void }) => (
    <div data-testid="period-calendar">
      <button type="button" onClick={() => onSelect(new Date(2026, 8, 15))}>
        选择 2026-09-15
      </button>
    </div>
  ),
}));
vi.mock("@plane/ui", async () => ({
  ...(await vi.importActual("@plane/ui")),
  EModalPosition: { CENTER: "center" },
  EModalWidth: { LG: "lg" },
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  ModalCore: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}));
vi.mock("@/components/research/common/browse-filters", () => ({
  ResearchBrowseFilters: mocks.browseFilters,
}));
vi.mock("@/components/research/common/error-messages", () => ({
  getResearchErrorKey: (error: unknown) =>
    (error as { error_code?: string }).error_code === "report_period_conflict"
      ? "research.errors.report_period_conflict"
      : "error",
}));
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
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    identity: {
      user: { org_units: [{ org_unit: "unit-1", is_primary: true }] },
      workspace: { report_timezone: "Asia/Shanghai" },
    },
    reportLoader: false,
    reportPaginationByWorkspace: {},
    getReports: () => mocks.getReports(),
    getOrgUnits: () => [],
    getResearchProjects: () => [],
    getReportTemplateOptions: () => [activeTemplate],
    templatesLoader: false,
    fetchReports: mocks.fetchReports,
    fetchResearchProjects: mocks.fetchResearchProjects,
    fetchOrgUnits: mocks.fetchOrgUnits,
    fetchReportTemplateOptions: mocks.fetchReportTemplateOptions,
    checkReportPeriod: mocks.checkReportPeriod,
    createReport: mocks.createReport,
    restoreReport: mocks.restoreReport,
  }),
}));

const { ResearchReportList } = await import("@/components/research/reports/report-list");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

/** Render the report list with its default test props. */
const ReportScopeProbe = () => <ResearchReportList workspaceSlug="lab" />;

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
  activeTemplate = { ...template };
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 27, 15, 0, 0));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.fetchReportTemplateOptions.mockImplementation(async (_workspaceSlug: string, params = {}) => {
    activeTemplate = { ...activeTemplate, report_type: params.report_type ?? "WEEKLY" };
    return [activeTemplate];
  });
  mocks.fetchReports.mockResolvedValue([]);
  mocks.fetchResearchProjects.mockResolvedValue([]);
  mocks.fetchOrgUnits.mockResolvedValue([]);
  mocks.createReport.mockResolvedValue({ id: "report-1" });
  mocks.checkReportPeriod.mockResolvedValue(null);
  mocks.restoreReport.mockResolvedValue({ id: "report-deleted" });
  mocks.browseFilters.mockImplementation(() => null);
  mocks.getReports.mockReturnValue([]);
  mocks.copyTextToClipboard.mockReset();
  mocks.copyTextToClipboard.mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.useRealTimers();
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
  expect(mocks.fetchReportTemplateOptions).toHaveBeenCalledWith("lab", { report_type: "WEEKLY" });
  expect(container.textContent).toContain("Graphite weekly template");

  const select = container.querySelector<HTMLSelectElement>('select[aria-label="模板"]');
  if (!select) throw new Error("模板选择未显示");
  expect(select.value).toBe("template-1");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, "template-1");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("创建报告").click());

  expect(mocks.checkReportPeriod).toHaveBeenCalledWith("lab", "WEEKLY", "2026-W44");
  expect(mocks.createReport).toHaveBeenCalledWith("lab", {
    report_type: "WEEKLY",
    period_key: "2026-W44",
    team_projects: [],
    template: "template-1",
  });
  expect(container.querySelector('output[aria-label="URL"]')?.textContent).toBe("/lab/research/reports/report-1");
});

it("创建弹窗默认当前周、禁止手填并支持历史补交周期", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/reports"]}>
        <ReportScopeProbe />
      </MemoryRouter>
    )
  );
  await act(async () => button("创建报告").click());
  await act(async () => undefined);

  expect(container.querySelector("input[placeholder='周期，例如 2026-W38 / 2026-09']")).toBeNull();
  expect(container.textContent).toContain("2026-W44");
  expect(container.textContent).toContain("2026-10-26 ~ 2026-11-01");
  expect(container.textContent).not.toContain("补交");

  await act(async () => button("选择 2026-09-15").click());
  await act(async () => undefined);
  expect(container.textContent).toContain("2026-W38");
  expect(container.textContent).toContain("2026-09-14 ~ 2026-09-20");
  expect(container.textContent).toContain("补交");
  expect(mocks.checkReportPeriod).toHaveBeenLastCalledWith("lab", "WEEKLY", "2026-W38");
});

it("切换周报和月报时重算当前周期并选择对应默认模板", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/reports"]}>
        <ReportScopeProbe />
      </MemoryRouter>
    )
  );
  await act(async () => button("创建报告").click());

  const monthMode = [...container.querySelectorAll("button")].find((item) => item.textContent === "按月");
  if (!monthMode) throw new Error("按月切换未显示");
  await act(async () => monthMode.click());
  await act(async () => undefined);

  expect(mocks.fetchReportTemplateOptions).toHaveBeenLastCalledWith("lab", { report_type: "MONTHLY" });
  expect(container.textContent).toContain("2026-10");
  expect(mocks.checkReportPeriod).toHaveBeenLastCalledWith("lab", "MONTHLY", "2026-10");
  const templateSelect = container.querySelector<HTMLSelectElement>('select[aria-label="模板"]');
  expect(templateSelect?.value).toBe("template-1");
});

it("重复周期预检后禁用创建并引导打开已有报告", async () => {
  mocks.checkReportPeriod.mockResolvedValue({ id: "existing-report", period_key: "2026-W44" });
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
  await act(async () => undefined);

  const submit = [...container.querySelectorAll("button")].toReversed().find((item) => item.textContent === "创建报告");
  expect(submit?.disabled).toBe(true);
  await act(async () => button("打开").click());
  expect(container.querySelector('output[aria-label="URL"]')?.textContent).toBe(
    "/lab/research/reports/existing-report"
  );
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(mocks.createReport).not.toHaveBeenCalled();
});

it("创建接口周期冲突时保留弹窗并显示内联错误", async () => {
  mocks.createReport.mockRejectedValue({ error_code: "report_period_conflict" });
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/reports"]}>
        <ReportScopeProbe />
      </MemoryRouter>
    )
  );
  await act(async () => button("创建报告").click());
  await act(async () => undefined);
  const submit = [...container.querySelectorAll("button")].toReversed().find((item) => item.textContent === "创建报告");
  if (!submit) throw new Error("创建按钮未显示");
  await act(async () => submit.click());
  await act(async () => undefined);

  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("该周期已有报告。");
  expect(container.textContent).toContain("2026-W44");
});

it("周期预检失败时不阻断创建提交", async () => {
  mocks.checkReportPeriod.mockRejectedValue(new Error("network unavailable"));
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/reports"]}>
        <ReportScopeProbe />
      </MemoryRouter>
    )
  );
  await act(async () => button("创建报告").click());
  await act(async () => undefined);
  const submit = [...container.querySelectorAll("button")].toReversed().find((item) => item.textContent === "创建报告");
  if (!submit) throw new Error("创建按钮未显示");
  expect(submit.disabled).toBe(false);

  await act(async () => submit.click());

  expect(mocks.createReport).toHaveBeenCalledWith("lab", {
    report_type: "WEEKLY",
    period_key: "2026-W44",
    team_projects: [],
    template: "template-1",
  });
});

it("报告列表回放 mine 旧链接并只携带报告领域参数", async () => {
  const search =
    "?mine=true&owner=uuid&q=graphite&date_from=2026-10-01&date_to=2026-10-08&org_unit=org-1&cursor=cursor-1&status=SUBMITTED&report_type=WEEKLY&period_key=2026-W40";
  function Probe() {
    const location = useLocation();
    return (
      <>
        <ResearchReportList workspaceSlug="lab" />
        <output aria-label="URL">{`${location.pathname}${location.search}`}</output>
      </>
    );
  }

  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[`/lab/research/reports${search}`]}>
        <Probe />
      </MemoryRouter>
    )
  );
  await act(async () => undefined);

  expect(container.querySelector('output[aria-label="URL"]')?.textContent).toBe(`/lab/research/reports${search}`);
  expect(mocks.fetchReports).toHaveBeenCalledWith("lab", {
    per_page: "50",
    mine: "true",
    owner: "uuid",
    q: "graphite",
    date_from: "2026-10-01",
    date_to: "2026-10-08",
    org_unit: "org-1",
    cursor: "cursor-1",
    status: "SUBMITTED",
    report_type: "WEEKLY",
    period_key: "2026-W40",
  });
  expect(mocks.fetchReports.mock.calls[0]?.[1]).not.toHaveProperty("workflow_status");
  expect(mocks.fetchReports.mock.calls[0]?.[1]).not.toHaveProperty("research_type");
});

it("报告列表 scope=mine 新链接不再输出 mine 请求参数", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/reports?scope=mine"]}>
        <ReportScopeProbe />
      </MemoryRouter>
    )
  );
  await act(async () => undefined);

  expect(mocks.fetchReports).toHaveBeenCalledWith("lab", {
    per_page: "50",
    scope: "mine",
  });
  expect(mocks.fetchReports.mock.calls[0]?.[1]).not.toHaveProperty("mine");
});

it("报告列表仅保留打开入口且不提供复制分享", async () => {
  mocks.getReports.mockReturnValue([
    {
      id: "report-weekly",
      period_key: "2026-W40",
      report_type: "WEEKLY",
      status: "DRAFT",
      visibility: "PRIVATE",
      owner_detail: { display_name: "学生一" },
    },
    {
      id: "report-monthly",
      period_key: "2026-10",
      report_type: "MONTHLY",
      status: "DRAFT",
      visibility: "PRIVATE",
      owner_detail: { email: "student@lab.local" },
    },
  ]);

  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/reports"]}>
        <ReportScopeProbe />
      </MemoryRouter>
    )
  );
  await act(async () => undefined);

  expect(container.querySelector('a[href="/lab/research/reports/report-weekly"]')).not.toBeNull();
  expect(container.querySelector('a[href="/lab/research/reports/report-monthly"]')).not.toBeNull();
  expect(
    [...container.querySelectorAll("button")].some((item) => item.getAttribute("aria-label")?.includes("复制分享链接"))
  ).toBe(false);
  expect(mocks.copyTextToClipboard).not.toHaveBeenCalled();
});

it("已删除报告使用独立范围且不提供详情链接", async () => {
  mocks.getReports.mockReturnValue([
    {
      id: "report-deleted",
      period_key: "2026-W40",
      report_type: "WEEKLY",
      status: "DRAFT",
      owner: "student",
      owner_detail: { display_name: "Student" },
      org_unit_detail: { name: "Group" },
      visibility: "PRIVATE",
      effective_visibility: "PRIVATE",
      has_read: false,
      read_count: 0,
      latest_read_at: null,
      deleted_at: "2026-10-26T02:00:00Z",
      can_restore: true,
    },
  ]);

  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/reports?scope=deleted"]}>
        <ReportScopeProbe />
      </MemoryRouter>
    )
  );
  await act(async () => undefined);

  expect(mocks.fetchReports).toHaveBeenCalledWith("lab", { per_page: "50", scope: "deleted" });
  expect(mocks.browseFilters.mock.calls.at(-1)?.[0]).toEqual(
    expect.objectContaining({ workspaceSlug: "lab", kind: "reports", includeDeleted: true })
  );
  expect(container.textContent).toContain("已删除报告");
  expect(container.textContent).toContain("已删除");
  expect(container.textContent).toContain("2026");
  expect(container.querySelector('a[href="/lab/research/reports/report-deleted"]')).toBeNull();
  expect(Array.from(container.querySelectorAll("button")).some((item) => item.textContent === "创建报告")).toBe(false);
});

it("恢复已删除报告后提示成功并打开详情", async () => {
  mocks.getReports.mockReturnValue([
    {
      id: "report-deleted",
      period_key: "2026-W40",
      report_type: "WEEKLY",
      status: "DRAFT",
      owner: "student",
      owner_detail: { display_name: "Student" },
      org_unit_detail: { name: "Group" },
      visibility: "PRIVATE",
      effective_visibility: "PRIVATE",
      deleted_at: "2026-10-26T02:00:00Z",
      can_restore: true,
    },
  ]);
  function Probe() {
    const location = useLocation();
    return (
      <>
        <ResearchReportList workspaceSlug="lab" />
        <output aria-label="URL">{`${location.pathname}${location.search}`}</output>
      </>
    );
  }

  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/reports?scope=deleted"]}>
        <Probe />
      </MemoryRouter>
    )
  );
  await act(async () => button("恢复").click());

  expect(mocks.restoreReport).toHaveBeenCalledWith("lab", "report-deleted");
  expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ type: "SUCCESS", title: "报告已恢复" }));
  expect(container.querySelector('output[aria-label="URL"]')?.textContent).toBe("/lab/research/reports/report-deleted");
});

it("恢复周期冲突时保留已删除列表并显示错误", async () => {
  mocks.getReports.mockReturnValue([
    {
      id: "report-deleted",
      period_key: "2026-W40",
      report_type: "WEEKLY",
      status: "DRAFT",
      owner: "student",
      owner_detail: { display_name: "Student" },
      org_unit_detail: { name: "Group" },
      visibility: "PRIVATE",
      effective_visibility: "PRIVATE",
      deleted_at: "2026-10-26T02:00:00Z",
      can_restore: true,
    },
  ]);
  mocks.restoreReport.mockRejectedValue({ error_code: "report_period_conflict" });

  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/reports?scope=deleted"]}>
        <ReportScopeProbe />
      </MemoryRouter>
    )
  );
  await act(async () => button("恢复").click());

  expect(container.textContent).toContain("该周期已有报告。");
  expect(container.textContent).toContain("2026-W40");
  expect(button("恢复")).toBeInstanceOf(HTMLButtonElement);
});

it("报告审核列表区分待阅读和已读待审阅", async () => {
  mocks.getReports.mockReturnValue([
    {
      id: "report-unread",
      period_key: "2026-W40",
      status: "SUBMITTED",
      visibility: "DIRECT_ADVISOR",
      has_read: false,
      read_count: 0,
      latest_read_at: null,
    },
    {
      id: "report-read",
      period_key: "2026-W39",
      status: "SUBMITTED",
      visibility: "DIRECT_ADVISOR",
      has_read: true,
      read_count: 1,
      latest_read_at: "2026-10-10T08:09:00Z",
    },
  ]);

  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/approvals?tab=report_review&scope=deleted"]}>
        <ResearchReportList workspaceSlug="lab" variant="review" />
      </MemoryRouter>
    )
  );

  const rows = [...container.querySelectorAll("tr")];
  expect(rows[1]?.textContent).toContain("待阅读");
  expect(rows[2]?.textContent).toContain("已读 · 待审阅");
  expect(mocks.browseFilters.mock.calls.at(-1)?.[0]).toEqual(
    expect.objectContaining({ kind: "reports", includeDeleted: false })
  );
  expect(mocks.fetchReports.mock.calls.at(-1)?.[1]).toEqual({ per_page: "50", status: "SUBMITTED" });
  expect(mocks.fetchReports.mock.calls.at(-1)?.[1]).not.toHaveProperty("scope");
});

it("保密周报按有效可见范围展示为本组保密", async () => {
  mocks.getReports.mockReturnValue([
    {
      id: "report-confidential",
      period_key: "2026-W40",
      status: "SUBMITTED",
      visibility: "WORKSPACE",
      effective_visibility: "UNIT",
      weekly_confidential: true,
      has_read: true,
      read_count: 1,
      latest_read_at: null,
    },
  ]);

  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/approvals?tab=report_review"]}>
        <ResearchReportList workspaceSlug="lab" variant="review" />
      </MemoryRouter>
    )
  );

  expect(container.querySelectorAll("tr")[1]?.textContent).toContain("本组（保密）");
});
