// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  fetchIdentity: vi.fn(),
  getChainNodes: vi.fn(),
  getKnowledgeUploads: vi.fn(),
  getResearchTodos: vi.fn(),
  fetchReportSummary: vi.fn(),
  getReportSummary: vi.fn(),
  fetchWorkspaceWidgets: vi.fn(),
  updateWorkspaceWidget: vi.fn(),
  fetchWorkspaceActivities: vi.fn(),
  identityWorkspaceSlug: "lab",
  getChains: vi.fn(),
  fetchProjects: vi.fn(),
  fetchProjectAnalyticsCount: vi.fn(),
  researchIdentity: {
    module_enabled: true,
    workspace_enabled: true,
    sections: { research_chain: true, reports: true },
    capabilities: { nav: ["research_chain", "summary"] },
    user: { id: "student-1", is_workspace_admin: false, org_units: [] },
    workspace: { slug: "lab", purpose: "GENERAL", report_timezone: "Asia/Shanghai" },
  },
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const literal = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      const text = typeof literal === "string" ? literal : key;
      if (!values) return text;
      return Object.entries(values).reduce(
        (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
        text
      );
    },
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@plane/propel/calendar", () => ({
  Calendar: ({ onSelect, disabled }: { onSelect: (date: Date | undefined) => void; disabled?: unknown }) => (
    <div data-testid="report-period-calendar" data-disabled={String(disabled !== undefined)}>
      <button type="button" onClick={() => onSelect(new Date(2026, 8, 15))}>
        选择 2026-09-15
      </button>
      <button type="button" onClick={() => onSelect(new Date(new Date().getFullYear() + 1, 0, 1))}>
        选择未来日期
      </button>
    </div>
  ),
}));
vi.mock("@plane/propel/popover", () => {
  const PopoverContext = React.createContext<{ open: boolean; onOpenChange: (open: boolean) => void } | null>(null);
  const Popover = Object.assign(
    ({
      children,
      open = false,
      onOpenChange,
    }: {
      children: React.ReactNode;
      open?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => {
      const value = React.useMemo(
        () => ({ open, onOpenChange: onOpenChange ?? Function.prototype }),
        [open, onOpenChange]
      );
      return (
        <PopoverContext.Provider value={value}>
          <div>{children}</div>
        </PopoverContext.Provider>
      );
    },
    {
      Button: ({ children, onClick, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
        const context = React.useContext(PopoverContext);
        return (
          <button
            {...props}
            onClick={(event) => {
              onClick?.(event);
              context?.onOpenChange(!context.open);
            }}
          >
            {children}
          </button>
        );
      },
      Panel: ({ children }: { children: React.ReactNode }) => {
        const context = React.useContext(PopoverContext);
        return context?.open ? <div>{children}</div> : null;
      },
    }
  );
  return { Popover };
});
vi.mock("@/hooks/store/use-research", () => {
  const researchStore = {
    get identity() {
      return mocks.researchIdentity;
    },
    get identityWorkspaceSlug() {
      return mocks.identityWorkspaceSlug;
    },
    canSee: (key: string) => mocks.researchIdentity.capabilities.nav.includes(key),
    fetchIdentity: mocks.fetchIdentity,
    fetchReportSummary: mocks.fetchReportSummary,
  };
  return { useResearch: () => researchStore };
});
vi.mock("@/hooks/store/use-project", () => {
  const projectStore = {
    fetchProjects: mocks.fetchProjects,
    fetchProjectAnalyticsCount: mocks.fetchProjectAnalyticsCount,
  };
  return { useProject: () => projectStore };
});
vi.mock("@/services/research/chain.service", () => ({
  ResearchChainService: class {
    getChains = mocks.getChains;
    getChainNodes = mocks.getChainNodes;
    getKnowledgeUploads = mocks.getKnowledgeUploads;
  },
}));
vi.mock("@/services/research/research-todo.service", () => ({
  ResearchTodoService: class {
    getResearchTodos = mocks.getResearchTodos;
  },
}));
vi.mock("@/services/research/report.service", () => ({
  ResearchReportService: class {
    getSummary = mocks.getReportSummary;
  },
}));
vi.mock("@/services/workspace.service", () => ({
  WorkspaceService: class {
    fetchWorkspaceWidgets = mocks.fetchWorkspaceWidgets;
    updateWorkspaceWidget = mocks.updateWorkspaceWidget;
    fetchWorkspaceActivities = mocks.fetchWorkspaceActivities;
  },
}));

vi.mock("@/hooks/use-workspace-context", () => ({ useWorkspaceContext: () => ({ context: mocks.researchIdentity }) }));
vi.mock("@/services/project-domains.service", () => ({
  ProjectDomainsService: class {
    todos = mocks.getResearchTodos;
  },
  domainError: () => "请求失败",
}));

const { WorkspaceHomeWorkbench } = await import("@/components/home/workbench");
const { reportPeriodEnd, reportPeriodKey } = await import("@/components/home/report-period-selector");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let swrCache: Map<string, unknown>;

function renderHome(initialPath = "/lab", workspaceSlug = "lab") {
  return act(async () =>
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <SWRConfig value={{ provider: () => swrCache, dedupingInterval: 0, shouldRetryOnError: false }}>
          <WorkspaceHomeWorkbench workspaceSlug={workspaceSlug} />
        </SWRConfig>
      </MemoryRouter>
    )
  );
}

function project(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "admin-project",
    name: "设备采购协作",
    identifier: "PROC",
    archived_at: null,
    is_research_project: false,
    updated_at: "2026-10-08T08:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  mocks.identityWorkspaceSlug = "lab";
  swrCache = new Map();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.fetchWorkspaceWidgets.mockResolvedValue([
    { key: "my_todos", is_enabled: true, config: { size: "medium" }, sort_order: 1100 },
    { key: "research_projects", is_enabled: true, config: { size: "large" }, sort_order: 1000 },
    { key: "administrative_projects", is_enabled: true, config: { size: "medium" }, sort_order: 900 },
    { key: "recent_activity", is_enabled: true, config: { size: "medium" }, sort_order: 800 },
    { key: "report_summary", is_enabled: true, config: { size: "medium" }, sort_order: 700 },
    { key: "workbench_layout", is_enabled: true, config: { density: "compact" }, sort_order: 100 },
  ]);
  mocks.updateWorkspaceWidget.mockImplementation((_slug: string, key: string, data: unknown) =>
    Promise.resolve({ key, ...(data as object) })
  );
  mocks.fetchWorkspaceActivities.mockResolvedValue({
    results: [
      {
        id: "activity-1",
        source: "project",
        actor: { id: "student-1", display_name: "学生一" },
        action: "updated",
        entity_type: "project",
        entity_id: "admin-project",
        entity_name: "设备采购协作",
        project: { id: "admin-project", name: "设备采购协作", identifier: "PROC" },
        url: "/lab/projects/admin-project/issues",
        occurred_at: "2026-10-12T08:00:00Z",
        changes: [{ field: "name", old_value: "旧名称", new_value: "设备采购协作" }],
        summary: "",
      },
    ],
    next_offset: null,
    has_more: false,
    offset: 0,
    per_page: 12,
  });
  mocks.getResearchTodos.mockResolvedValue({
    schema_version: "research-todo.v2",
    results: [],
    count: 0,
    total_count: 0,
    next_cursor: null,
    degraded_sources: [],
  });
  mocks.fetchIdentity.mockResolvedValue(null);
  mocks.getChains.mockResolvedValue([
    {
      id: "chain-1",
      project: "research-project",
      project_name: "催化剂失活机理研究",
      owner: "student-1",
      owner_name: "学生一",
      status: "ACTIVE",
      visibility: "ORG",
      updated_at: "2026-10-09T08:00:00Z",
      open_task_count: 2,
      next_due_at: "2026-10-12T09:00:00Z",
      current_node: {
        id: "node-1",
        title: "实验数据分析",
        status: "WAITING_HUMAN",
        node_type: "ANALYSIS",
        updated_at: "2026-10-09T07:00:00Z",
      },
    },
  ]);
  mocks.fetchProjects.mockResolvedValue([
    project(),
    project({ id: "research-project", name: "科研项目内部 Project", is_research_project: true }),
  ]);
  mocks.fetchProjectAnalyticsCount.mockResolvedValue([
    { id: "admin-project", open_issues: 3, done_issues: 2, last_activity_at: "2026-10-11T08:30:00Z" },
  ]);
  mocks.fetchReportSummary.mockResolvedValue({
    period_key: "2026-W41",
    period_start: "2026-10-05",
    period_end: "2026-10-11",
    counts: { not_submitted: 3, draft: 1, submitted: 5, needs_revision: 2, accepted: 8 },
  });
  mocks.getReportSummary.mockImplementation(async (_slug, params) =>
    params.report_type === "MONTHLY"
      ? {
          period_key: params.period_offset === -1 ? "2026-09" : "2026-10",
          period_start: params.period_offset === -1 ? "2026-09-01" : "2026-10-01",
          period_end: params.period_offset === -1 ? "2026-09-30" : "2026-10-31",
          counts: {
            not_submitted: params.period_offset === -1 ? 12 : 13,
            draft: params.period_offset === -1 ? 3 : 4,
            submitted: params.period_offset === -1 ? 14 : 15,
            needs_revision: params.period_offset === -1 ? 11 : 12,
            accepted: params.period_offset === -1 ? 17 : 18,
          },
        }
      : {
          period_key: params.period_offset === -1 ? "2026-W41" : "2026-W42",
          period_start: params.period_offset === -1 ? "2026-10-05" : "2026-10-12",
          period_end: params.period_offset === -1 ? "2026-10-11" : "2026-10-18",
          counts: {
            not_submitted: params.period_offset === -1 ? 2 : 3,
            draft: params.period_offset === -1 ? 0 : 1,
            submitted: params.period_offset === -1 ? 4 : 5,
            needs_revision: params.period_offset === -1 ? 1 : 2,
            accepted: params.period_offset === -1 ? 7 : 8,
          },
        }
  );
  mocks.researchIdentity.module_enabled = true;
  mocks.researchIdentity.workspace_enabled = true;
  mocks.researchIdentity.sections.research_chain = true;
  mocks.researchIdentity.sections.reports = true;
  mocks.researchIdentity.capabilities.nav = ["research_chain", "summary"];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it("renders the action-first bento home information architecture without generic widgets", async () => {
  await renderHome();
  await act(async () => undefined);

  const columns = container.querySelector("[data-testid='workspace-home-columns']");
  expect(mocks.getResearchTodos).toHaveBeenCalledWith("lab", "all", undefined);
  expect(columns?.className).toContain("min-w-0");
  expect(columns?.className).toContain("grid-cols-1");
  expect(columns?.className).toContain("xl:grid-cols-12");
  for (const title of ["科研项目概览", "行政项目概览", "我的待办", "最近动态", "报告提交摘要"]) {
    expect(container.textContent).toContain(title);
  }
  expect(container.querySelector('a[href="/lab/todos"]')?.textContent).toBe("查看全部待办");
  expect(container.querySelector('a[href="/lab/research/todos"]')).toBeNull();
  expect(
    container.querySelector('a[href="/lab/research/chains/?view=reports&report_type=WEEKLY&period_key=2026-W42"]')
  ).not.toBeNull();
  expect(container.textContent).not.toContain("快捷入口");
  expect(container.textContent).not.toContain("我的工作");
  expect(container.textContent).not.toContain("便签");
  expect(container.textContent).not.toContain("草稿");
});

it("migrates a legacy detailed density preference to the user account", async () => {
  window.localStorage.setItem("plane.home.workbench.density", "detailed");
  await renderHome();
  await act(async () => undefined);
  expect(mocks.updateWorkspaceWidget).toHaveBeenCalledWith(
    "lab",
    "workbench_layout",
    expect.objectContaining({ config: expect.objectContaining({ density: "detailed" }) })
  );
  expect(window.localStorage.getItem("plane.home.workbench.density")).toBe("detailed");
});

it("supports a focused one-widget home without fetching hidden modules", async () => {
  mocks.fetchWorkspaceWidgets.mockResolvedValue(
    mocks.fetchWorkspaceWidgets.mock.calls.at(-1)?.[0] ?? [
      { key: "my_todos", is_enabled: true, config: { size: "medium" }, sort_order: 1100 },
      { key: "research_projects", is_enabled: false, config: { size: "large" }, sort_order: 1000 },
      { key: "administrative_projects", is_enabled: false, config: { size: "medium" }, sort_order: 900 },
      { key: "recent_activity", is_enabled: false, config: { size: "medium" }, sort_order: 800 },
      { key: "report_summary", is_enabled: false, config: { size: "medium" }, sort_order: 700 },
      { key: "workbench_layout", is_enabled: true, config: { density: "compact" }, sort_order: 100 },
    ]
  );
  // 直接传值，避免依赖上一个测试的 mock call 参数。
  mocks.fetchWorkspaceWidgets.mockResolvedValue([
    { key: "my_todos", is_enabled: true, config: { size: "medium" }, sort_order: 1100 },
    { key: "research_projects", is_enabled: false, config: { size: "large" }, sort_order: 1000 },
    { key: "administrative_projects", is_enabled: false, config: { size: "medium" }, sort_order: 900 },
    { key: "recent_activity", is_enabled: false, config: { size: "medium" }, sort_order: 800 },
    { key: "report_summary", is_enabled: false, config: { size: "medium" }, sort_order: 700 },
    { key: "workbench_layout", is_enabled: true, config: { density: "compact" }, sort_order: 100 },
  ]);
  await renderHome();
  await act(async () => undefined);

  const grid = container.querySelector('[data-testid="workspace-home-columns"]')!;
  expect([...grid.children].map((section) => section.getAttribute("aria-label"))).toEqual(["我的待办"]);
  expect(grid.querySelector("section")?.classList.contains("xl:col-span-12")).toBe(true);
  expect(mocks.getChains).not.toHaveBeenCalled();
  expect(mocks.fetchProjects).not.toHaveBeenCalled();
  expect(mocks.getReportSummary).not.toHaveBeenCalled();
  expect(mocks.fetchWorkspaceActivities).not.toHaveBeenCalled();
});

it("persists order and width for a focused two-widget home", async () => {
  mocks.fetchWorkspaceWidgets.mockResolvedValue([
    { key: "my_todos", is_enabled: true, config: { size: "medium" }, sort_order: 1100 },
    { key: "research_projects", is_enabled: false, config: { size: "large" }, sort_order: 1000 },
    { key: "administrative_projects", is_enabled: false, config: { size: "medium" }, sort_order: 900 },
    { key: "recent_activity", is_enabled: true, config: { size: "medium" }, sort_order: 800 },
    { key: "report_summary", is_enabled: false, config: { size: "medium" }, sort_order: 700 },
    { key: "workbench_layout", is_enabled: true, config: { density: "compact" }, sort_order: 100 },
  ]);
  await renderHome();
  const customize = [...container.querySelectorAll("button")].find((button) => button.textContent === "自定义首页");
  await act(async () => customize?.click());

  /* oxlint-disable no-await-in-loop -- 顺序上移必须等待每次乐观排序完成。 */
  for (let index = 0; index < 3; index += 1) {
    const row = [...container.querySelectorAll('[role="listitem"]')].find((entry) =>
      entry.textContent?.includes("最近动态")
    );
    await act(async () => row?.querySelector('button[aria-label="上移"]')?.click());
    await act(async () => undefined);
  }
  /* oxlint-enable no-await-in-loop */
  const currentActivityRow = [...container.querySelectorAll('[role="listitem"]')].find((row) =>
    row.textContent?.includes("最近动态")
  );
  const fullButton = [...(currentActivityRow?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === "整行"
  );
  await act(async () => fullButton?.click());
  await act(async () => undefined);

  expect(mocks.updateWorkspaceWidget).toHaveBeenCalledWith(
    "lab",
    "recent_activity",
    expect.objectContaining({ config: expect.objectContaining({ size: "medium" }) })
  );
  expect(mocks.updateWorkspaceWidget).toHaveBeenCalledWith(
    "lab",
    "recent_activity",
    expect.objectContaining({ config: expect.objectContaining({ size: "full" }) })
  );
  const grid = container.querySelector('[data-testid="workspace-home-columns"]')!;
  const visualOrder = [...grid.children]
    .map((section) => ({
      label: section.getAttribute("aria-label"),
      order: Number(
        ([...section.classList].find((className) => /^order-\d+$/.test(className)) ?? "order-99").replace("order-", "")
      ),
    }))
    .toSorted((left, right) => left.order - right.order)
    .map((entry) => entry.label);
  expect(visualOrder).toEqual(["最近动态", "我的待办"]);
});

it("keeps enabled widgets on a natural long page and persists density", async () => {
  await renderHome();
  await act(async () => undefined);

  const cards = [...container.querySelectorAll('[data-testid="workspace-home-columns"] > section')];
  expect(cards.length).toBeGreaterThanOrEqual(5);
  for (const card of cards) {
    expect(card.className).not.toMatch(/max-xl:h-\[(400|320)px\]/);
    expect(card.className).not.toContain("xl:h-full");
    const body = card.querySelector("div.border-t");
    expect(body?.className).not.toContain("overflow-y-auto");
  }
  const grid = container.querySelector("[data-testid='workspace-home-columns']");
  expect(grid?.className).not.toContain("xl:flex-1");

  const customize = [...container.querySelectorAll("button")].find((button) => button.textContent === "自定义首页");
  await act(async () => customize?.click());
  const detailedButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "详细");
  await act(async () => detailedButton?.click());
  expect(window.localStorage.getItem("plane.home.workbench.density")).toBe("detailed");
  expect(mocks.updateWorkspaceWidget).toHaveBeenCalledWith(
    "lab",
    "workbench_layout",
    expect.objectContaining({ config: expect.objectContaining({ density: "detailed" }) })
  );
});

it.each([
  { research: true, summary: true, count: 5 },
  { research: true, summary: false, count: 4 },
  { research: false, summary: true, count: 4 },
  { research: false, summary: false, count: 3 },
])(
  "renders only permission-available widgets with research=$research and summary=$summary",
  async ({ research, summary, count }) => {
    mocks.researchIdentity.capabilities.nav = [
      ...(research ? ["research_chain"] : []),
      ...(summary ? ["summary"] : []),
    ];
    await renderHome();

    const grid = container.querySelector('[data-testid="workspace-home-columns"]')!;
    const section = (title: string) => grid.querySelector(`section[aria-label="${title}"]`);
    expect(grid.children).toHaveLength(count);
    expect(Boolean(section("科研项目概览"))).toBe(research);
    expect(Boolean(section("报告提交摘要"))).toBe(summary);
    expect(section("我的待办")?.classList.contains("xl:col-span-6")).toBe(true);
    if (research) expect(section("科研项目概览")?.classList.contains("xl:col-span-8")).toBe(true);
    for (const title of ["行政项目概览", "最近动态", ...(summary ? ["报告提交摘要"] : [])]) {
      expect(section(title)?.classList.contains("xl:col-span-6")).toBe(true);
    }
    if (!research) expect(mocks.getChains).not.toHaveBeenCalled();
    if (!summary) expect(mocks.getReportSummary).not.toHaveBeenCalled();
  }
);

it("removes unavailable widgets without changing user widget order", async () => {
  await renderHome();
  mocks.researchIdentity.capabilities.nav = [];
  await renderHome();
  const grid = container.querySelector('[data-testid="workspace-home-columns"]')!;
  expect(grid.children).toHaveLength(3);
  expect([...grid.children].map((section) => section.getAttribute("aria-label"))).toEqual([
    "我的待办",
    "行政项目概览",
    "最近动态",
  ]);
  expect(grid.querySelector('section[aria-label="科研项目概览"]')).toBeNull();
  expect(grid.querySelector('section[aria-label="报告提交摘要"]')).toBeNull();
});

it("keeps research and administrative project summaries separate", async () => {
  await renderHome();
  await act(async () => undefined);

  expect(container.textContent).toContain("催化剂失活机理研究");
  expect(container.textContent).toContain("负责人：学生一");
  expect(container.textContent).toContain("实验数据分析");
  expect(container.textContent).toContain("2 项待办");
  expect(container.textContent).toContain("设备采购协作");
  expect(container.textContent).not.toContain("科研项目内部 Project");
  expect(mocks.getChains).toHaveBeenCalledTimes(1);
  expect(mocks.fetchProjects).toHaveBeenCalledTimes(1);
});

it("excludes archived and deleted chains from rows, task counts and deadlines", async () => {
  const active = (await mocks.getChains())[0];
  mocks.getChains.mockClear();
  mocks.getChains.mockResolvedValue([
    active,
    {
      ...active,
      id: "archived",
      project_name: "归档项目",
      status: "ARCHIVED",
      open_task_count: 20,
      next_due_at: "2026-10-01T00:00:00Z",
    },
    { ...active, id: "deleted", project_name: "删除项目", status: "DELETED", open_task_count: 30 },
    {
      ...active,
      id: "completed",
      project_name: "完成项目",
      status: "COMPLETED",
      owner: "other",
      owner_name: "另一位负责人",
      open_task_count: 0,
    },
  ]);
  await renderHome();
  const section = container.querySelector('a[href="/lab/research/chains"]')?.closest("section");
  expect(section?.textContent).not.toContain("归档项目");
  expect(section?.textContent).not.toContain("删除项目");
  expect(section?.textContent).toContain("完成项目");
  expect(section?.textContent).toContain("负责人：另一位负责人");
  expect(section?.textContent).toContain("共 2 个课题");
  const metrics = section?.querySelector("div.grid-cols-3");
  expect(metrics?.textContent).toContain("未完成任务2");
  expect(metrics?.textContent).toContain("2026/10/12");
});

it("uses a readable placeholder without exposing a raw owner ID", async () => {
  const active = (await mocks.getChains())[0];
  mocks.getChains.mockResolvedValue([{ ...active, owner: "raw-owner-id", owner_name: "  " }]);
  await renderHome();
  expect(container.textContent).toContain("负责人：未设置");
  expect(container.textContent).not.toContain("raw-owner-id");
});

it("renders an empty research overview when every chain is hidden", async () => {
  mocks.getChains.mockResolvedValue([{ status: "ARCHIVED" }, { status: "DELETED" }]);
  await renderHome();
  const section = container.querySelector('a[href="/lab/research/chains"]')?.closest("section");
  expect(section?.querySelectorAll("li")).toHaveLength(0);
  expect(section?.querySelector("div.grid-cols-3")).toBeNull();
  expect(section?.textContent).toContain("暂无");
});

it("uses the shared server todo projection and preserves URL scope changes", async () => {
  const todo = {
    schema_version: "research-todo.v2" as const,
    id: "REPORT:report-1",
    domain: "RESEARCH",
    source: "REPORT" as const,
    object_id: "report-1",
    title: "报告需修订 · 2026-W38",
    context: "高分子课题 / 周报",
    requester: { id: "student-1", display_name: "学生一" },
    assignees: [{ id: "advisor-1", display_name: "导师一" }],
    business_status: "NEEDS_REVISION",
    urgency: "NORMAL" as const,
    handling_status: "RETURNED" as const,
    next_action: "SUBMIT" as const,
    due_at: null,
    href: "/lab/research/reports/report-1",
    capabilities: { schema_version: "research-capabilities.v1" as const, actions: {} },
    trace_ref: null,
    updated_at: "2026-10-09T00:00:00Z",
  };
  mocks.getResearchTodos.mockResolvedValue({
    schema_version: "research-todo.v2",
    results: [todo],
    count: 1,
    total_count: 1,
    next_cursor: null,
    degraded_sources: [],
  });

  await renderHome();
  expect(mocks.getResearchTodos).toHaveBeenCalledWith("lab", "all", undefined);
  expect(container.textContent).toContain("报告需修订");
  const filter = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "行政");
  await act(async () => filter?.click());
  expect(mocks.getResearchTodos).toHaveBeenLastCalledWith("lab", "administrative", undefined);
});

it("shows the compact report submission summary and refreshes the workbench", async () => {
  await renderHome();
  await act(async () => undefined);

  expect(container.textContent).toContain("2026-W42");
  for (const label of ["未提交3", "需修改2", "已验收8"]) {
    expect(container.textContent).toContain(label);
  }

  const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent === "刷新");
  await act(async () => refresh?.click());
  expect(mocks.getChains).toHaveBeenCalledTimes(2);
  expect(mocks.fetchProjects).toHaveBeenCalledTimes(2);
  expect(mocks.fetchProjectAnalyticsCount).toHaveBeenCalledTimes(2);
  expect(mocks.getReportSummary).toHaveBeenCalledTimes(2);
  expect(mocks.fetchReportSummary).not.toHaveBeenCalled();
});

it("switches report periods without changing the global workbench period", async () => {
  await renderHome();
  expect(mocks.getReportSummary).toHaveBeenCalledTimes(1);
  expect(mocks.getReportSummary).toHaveBeenCalledWith("lab", { report_type: "WEEKLY", period_offset: 0 });
  const summary = container.querySelector('[role="group"][aria-label="本周"]');
  expect(summary?.textContent).toContain("2026-W42");
  expect(summary?.textContent).toContain("2026-10-12 ~ 2026-10-18");
  expect([...summary!.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
    "未提交3",
    "需修改2",
    "已提交5",
    "已验收8",
  ]);
  expect(
    [...summary!.querySelectorAll("a")].every(
      (link) =>
        link.getAttribute("href") === "/lab/research/chains/?view=reports&report_type=WEEKLY&period_key=2026-W42"
    )
  ).toBe(true);

  const lastWeek = [...container.querySelectorAll("button")].find((button) => button.textContent === "上周");
  await act(async () => lastWeek?.click());
  expect(mocks.getReportSummary).toHaveBeenLastCalledWith("lab", { report_type: "WEEKLY", period_offset: -1 });
  expect(container.querySelector('[role="group"][aria-label="上周"]')?.textContent).toContain("2026-W41");

  const lastMonth = [...container.querySelectorAll("button")].find((button) => button.textContent === "上月");
  await act(async () => lastMonth?.click());
  expect(mocks.getReportSummary).toHaveBeenLastCalledWith("lab", { report_type: "MONTHLY", period_offset: -1 });
  const month = container.querySelector('[role="group"][aria-label="上月"]');
  expect(month?.textContent).toContain("2026-09-01 ~ 2026-09-30");
  expect(
    [
      ...month!.querySelectorAll("a[href='/lab/research/chains/?view=reports&report_type=MONTHLY&period_key=2026-09']"),
    ].map((link) => link.textContent)
  ).toContain("已验收17");

  const allPeriod = [...container.querySelectorAll("button")].find((button) => button.textContent === "全部");
  await act(async () => allPeriod?.click());
  expect(mocks.getReportSummary).toHaveBeenCalledTimes(3);
});

it("loads an ISO week summary when a custom week date is selected", async () => {
  mocks.getReportSummary.mockImplementation(async (_slug, params) => {
    if (params.period_key) {
      return {
        period_key: params.period_key,
        period_start: "2026-09-14",
        period_end: "2026-09-20",
        counts: { not_submitted: 9, draft: 0, submitted: 6, needs_revision: 2, accepted: 4 },
      };
    }
    return {
      period_key: "2026-W42",
      period_start: "2026-10-12",
      period_end: "2026-10-18",
      counts: { not_submitted: 3, draft: 1, submitted: 5, needs_revision: 2, accepted: 8 },
    };
  });

  await renderHome();
  const customPeriod = [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "选择报告周期"
  );
  await act(async () => customPeriod?.click());
  expect(container.textContent).toContain("按周");

  const date = [...container.querySelectorAll("button")].find((button) => button.textContent === "选择 2026-09-15");
  await act(async () => date?.click());

  expect(mocks.getReportSummary).toHaveBeenLastCalledWith("lab", {
    report_type: "WEEKLY",
    period_key: "2026-W38",
  });
  const summary = container.querySelector('[role="group"][aria-label="自定义周期"]');
  expect(summary?.textContent).toContain("2026-W38");
  expect(summary?.textContent).toContain("2026-09-14 ~ 2026-09-20");
  expect(
    summary?.querySelector('a[href="/lab/research/chains/?view=reports&report_type=WEEKLY&period_key=2026-W38"]')
  ).not.toBeNull();
  expect([...container.querySelectorAll("button")].find((button) => button.textContent === "2026-W38")).toBeDefined();
});

it("loads a calendar month summary and passes the report timezone to the picker", async () => {
  mocks.getReportSummary.mockImplementation(async (_slug, params) => {
    if (params.period_key) {
      return {
        period_key: params.period_key,
        period_start: "2026-09-01",
        period_end: "2026-09-30",
        counts: { not_submitted: 9, draft: 0, submitted: 6, needs_revision: 2, accepted: 4 },
      };
    }
    return {
      period_key: "2026-W42",
      period_start: "2026-10-12",
      period_end: "2026-10-18",
      counts: { not_submitted: 3, draft: 1, submitted: 5, needs_revision: 2, accepted: 8 },
    };
  });

  await renderHome();
  const customPeriod = [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "选择报告周期"
  );
  await act(async () => customPeriod?.click());
  const monthMode = [...container.querySelectorAll("button")].find((button) => button.textContent === "按月");
  await act(async () => monthMode?.click());
  expect(container.querySelector('[data-testid="report-period-calendar"]')?.getAttribute("data-disabled")).toBe("true");

  const date = [...container.querySelectorAll("button")].find((button) => button.textContent === "选择 2026-09-15");
  await act(async () => date?.click());

  expect(mocks.getReportSummary).toHaveBeenLastCalledWith("lab", {
    report_type: "MONTHLY",
    period_key: "2026-09",
  });
  expect(container.querySelector('[role="group"][aria-label="自定义周期"]')?.textContent).toContain("2026-09");
});

it("derives custom keys and current boundaries in the workspace report timezone", () => {
  expect(reportPeriodKey("WEEKLY", new Date(2026, 8, 15))).toBe("2026-W38");
  expect(reportPeriodKey("MONTHLY", new Date(2026, 8, 15))).toBe("2026-09");

  const weekEnd = reportPeriodEnd("WEEKLY", "Asia/Shanghai", new Date("2026-09-20T16:30:00.000Z"));
  expect([weekEnd.getFullYear(), weekEnd.getMonth(), weekEnd.getDate()]).toEqual([2026, 8, 27]);

  const monthEnd = reportPeriodEnd("MONTHLY", "Asia/Shanghai", new Date("2026-08-31T16:30:00.000Z"));
  expect([monthEnd.getFullYear(), monthEnd.getMonth(), monthEnd.getDate()]).toEqual([2026, 8, 30]);
});

it("does not request a future custom period from the calendar trigger", async () => {
  await renderHome();
  const customPeriod = [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "选择报告周期"
  );
  await act(async () => customPeriod?.click());
  const requestCount = mocks.getReportSummary.mock.calls.length;

  const futureDate = [...container.querySelectorAll("button")].find((button) => button.textContent === "选择未来日期");
  await act(async () => futureDate?.click());

  expect(mocks.getReportSummary).toHaveBeenCalledTimes(requestCount);
  expect(container.querySelector('[role="group"][aria-label="本周"]')).not.toBeNull();
});

it("ignores a custom period response after returning to a preset", async () => {
  const pending: ((summary: unknown) => void)[] = [];
  mocks.getReportSummary.mockImplementation(() => new Promise((done) => pending.push(done)));

  await renderHome();
  const customPeriod = [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === "选择报告周期"
  );
  await act(async () => customPeriod?.click());
  const date = [...container.querySelectorAll("button")].find((button) => button.textContent === "选择 2026-09-15");
  await act(async () => date?.click());
  const currentMonth = [...container.querySelectorAll("button")].find((button) => button.textContent === "本月");
  await act(async () => currentMonth?.click());

  await act(async () => pending[1]({ period_key: "2026-W38", counts: { accepted: 999 } }));
  expect(container.textContent).not.toContain("2026-W38");
  await act(async () => pending[2]({ period_key: "2026-10", counts: { accepted: 8 } }));
  expect(container.querySelector('[role="group"][aria-label="本月"]')?.textContent).toContain("2026-10");
});

it("ignores a pending report response after the period preset changes", async () => {
  const pending: ((summary: unknown) => void)[] = [];
  mocks.getReportSummary.mockImplementation(() => new Promise((done) => pending.push(done)));
  await renderHome();
  const lastWeek = [...container.querySelectorAll("button")].find((button) => button.textContent === "上周");
  await act(async () => lastWeek?.click());

  await act(async () => pending[0]({ period_key: "stale-period", counts: { accepted: 999 } }));
  expect(container.textContent).not.toContain("stale-period");
  await act(async () => pending[1]({ period_key: "2026-W41", counts: { accepted: 7 } }));
  expect(container.querySelector('[role="group"][aria-label="上周"]')?.textContent).toContain("2026-W41");
});

it("places business activity before reports and revalidates on refresh", async () => {
  await renderHome();
  const grid = container.querySelector("[data-testid='workspace-home-columns']");
  expect([...grid!.children].slice(2).map((section) => section.getAttribute("aria-label"))).toEqual([
    "行政项目概览",
    "最近动态",
    "报告提交摘要",
  ]);
  expect(mocks.fetchWorkspaceActivities).toHaveBeenCalledWith("lab", { days: "30", offset: 0, per_page: 12 });
  const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent === "刷新");
  await act(async () => refresh?.click());
  expect(mocks.fetchWorkspaceActivities).toHaveBeenCalledTimes(2);
});

it("shows the selected summary error without inventing counts", async () => {
  mocks.getReportSummary.mockRejectedValueOnce(new Error("unavailable"));
  await renderHome();
  const summary = container.querySelector('[role="group"][aria-label="本周"]');
  expect(summary?.textContent).toContain("暂不可用");
  expect(container.querySelector('[aria-label="本周"] a')).toBeNull();
});

it("does not request or invent counts without summary permission", async () => {
  mocks.researchIdentity.sections.reports = false;
  await renderHome();
  const section = container.querySelector('section[aria-label="报告提交摘要"]');
  expect(mocks.getReportSummary).not.toHaveBeenCalled();
  expect(section).toBeNull();
});

it("shows the selected summary forbidden state", async () => {
  mocks.getReportSummary.mockRejectedValueOnce({ error_code: "research_permission_denied" });
  await renderHome();
  const summary = container.querySelector('[role="group"][aria-label="本周"]');
  expect(summary?.textContent).toContain("没有科研数据访问权限");
  expect(summary?.querySelector("a")).toBeNull();
});

it("ignores pending summaries when identity permissions change while summary access remains", async () => {
  const originalIdentity = mocks.researchIdentity;
  const pending: ((summary: unknown) => void)[] = [];
  mocks.getReportSummary.mockImplementation(() => new Promise((done) => pending.push(done)));
  try {
    await renderHome();
    mocks.researchIdentity = {
      ...originalIdentity,
      user: { ...originalIdentity.user, is_workspace_admin: true },
    };
    await renderHome();
    expect(mocks.getReportSummary).toHaveBeenCalledTimes(2);
    await act(async () => pending[0]({ period_key: "stale-identity", counts: {} }));
    expect(container.textContent).not.toContain("stale-identity");
    await act(async () => pending[1]({ period_key: "2026-W42", counts: { accepted: 8 } }));
    expect(container.querySelector('[role="group"][aria-label="本周"]')?.textContent).toContain("2026-W42");
  } finally {
    mocks.researchIdentity = originalIdentity;
  }
});

it("ignores a pending report response after permission is revoked", async () => {
  let resolve!: (summary: unknown) => void;
  mocks.getReportSummary.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  await renderHome();
  expect(container.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
  mocks.researchIdentity.sections.reports = false;
  await renderHome();
  await act(async () => resolve({ period_key: "stale-report", counts: { accepted: 999 } }));
  expect(container.textContent).not.toContain("stale-report");
  expect(container.querySelector('section[aria-label="报告提交摘要"] a')).toBeNull();
});

it("ignores report responses from the previous workspace", async () => {
  const pending: ((summary: unknown) => void)[] = [];
  mocks.getReportSummary.mockImplementation(() => new Promise((done) => pending.push(done)));
  await renderHome();
  mocks.identityWorkspaceSlug = "other";
  await renderHome("/other", "other");
  await act(async () => pending[0]({ period_key: "stale-workspace", counts: {} }));
  expect(container.textContent).not.toContain("stale-workspace");
  await act(async () => pending[1]({ period_key: "2026-W42", counts: { accepted: 8 } }));
  expect(container.querySelector('[role="group"][aria-label="本周"]')?.textContent).toContain("2026-W42");
});

it("uses a neutral research empty state when the caller has no research access", async () => {
  mocks.researchIdentity.sections.research_chain = false;
  vi.mocked(mocks.getChains).mockRejectedValue({ error_code: "research_permission_denied" });
  await renderHome();
  await act(async () => undefined);

  expect(container.querySelector('a[href="/lab/research/chains"]')).toBeNull();
  expect(container.textContent).toContain("设备采购协作");
  expect(container.textContent).not.toContain("催化剂失活机理研究");
});

it("loads administrative work statistics in one batch and shows dates and counts", async () => {
  await renderHome();
  expect(mocks.fetchProjectAnalyticsCount).toHaveBeenCalledWith("lab", {
    project_ids: "admin-project",
    fields: "open_issues,done_issues,last_activity_at",
  });
  const section = [...container.querySelectorAll('[data-testid="workspace-home-columns"] > section')].find((entry) =>
    entry.textContent?.includes("行政项目概览")
  );
  expect(section?.textContent).toContain("最近更新：");
  expect(section?.textContent).toContain("2026/10/11");
  expect(section?.textContent).toContain("未完成 3 项");
  expect(section?.textContent).toContain("已完成 2 项");
  expect(section?.querySelector('a[href="/lab/projects/admin-project/issues"]')).not.toBeNull();
});

it("sorts by work activity, keeps ties stable, and includes older unarchived projects", async () => {
  mocks.fetchProjects.mockResolvedValue([
    project({ id: "old", name: "旧项目", updated_at: "2025-01-01" }),
    project({ id: "tie-a", name: "同时间甲" }),
    project({ id: "new", name: "最近项目", updated_at: "2025-01-01" }),
    project({ id: "tie-b", name: "同时间乙" }),
    project({ id: "archived", name: "已归档项目", archived_at: "2026-10-01" }),
    project({ id: "research", name: "科研内部项目", is_research_project: true }),
  ]);
  mocks.fetchProjectAnalyticsCount.mockResolvedValue([
    { id: "old", open_issues: 0, done_issues: 0, last_activity_at: "2025-01-01T00:00:00Z" },
    { id: "tie-a", open_issues: 1, done_issues: 0, last_activity_at: "2026-10-09T00:00:00Z" },
    { id: "new", open_issues: 2, done_issues: 3, last_activity_at: "2026-10-12T00:00:00Z" },
    { id: "tie-b", open_issues: 0, done_issues: 1, last_activity_at: "2026-10-09T00:00:00Z" },
  ]);
  await renderHome();
  const adminSection = [...container.querySelectorAll('[data-testid="workspace-home-columns"] > section')].find(
    (entry) => entry.getAttribute("aria-label") === "行政项目概览"
  );
  const names = () => [...adminSection!.querySelectorAll('a[href$="/issues"]')].map((entry) => entry.textContent);
  expect(names()).toEqual(["最近项目", "同时间甲", "同时间乙", "旧项目"]);
  expect(adminSection?.textContent).not.toContain("已归档项目");
  expect(adminSection?.textContent).not.toContain("科研内部项目");
  const allPeriod = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "全部");
  await act(async () => allPeriod?.click());
  expect(names()).toEqual(["最近项目", "同时间甲", "同时间乙", "旧项目"]);
  expect(mocks.fetchProjectAnalyticsCount).toHaveBeenCalledTimes(1);
});

it("retains project links when statistics fail without inventing zero counts", async () => {
  mocks.fetchProjectAnalyticsCount.mockRejectedValue(new Error("unavailable"));
  await renderHome();
  expect(container.textContent).toContain("设备采购协作");
  expect(container.textContent).toContain("概览暂不可用");
  expect(container.textContent).toContain("最近更新：-");
  expect(container.textContent).not.toContain("未完成 0 项");
  expect(container.querySelector('a[href="/lab/projects/admin-project/issues"]')).not.toBeNull();
});

it("handles missing statistics and invalid dates without breaking the home", async () => {
  mocks.fetchProjects.mockResolvedValue([project(), project({ id: "missing", name: "缺失概览项目" })]);
  mocks.fetchProjectAnalyticsCount.mockResolvedValue([
    { id: "admin-project", open_issues: 0, done_issues: 0, last_activity_at: "invalid-date" },
  ]);
  await renderHome();
  expect(container.textContent).toContain("未完成 0 项");
  expect(container.textContent).toContain("已完成 0 项");
  expect(container.textContent).toContain("最近更新：-");
  expect(container.textContent).toContain("缺失概览项目");
  expect(container.textContent).toContain("概览暂不可用");
});

it("does not request statistics for an empty list or failed project fetch", async () => {
  mocks.fetchProjects.mockResolvedValue([]);
  await renderHome();
  expect(container.textContent).toContain("暂无行政项目。");
  expect(mocks.fetchProjectAnalyticsCount).not.toHaveBeenCalled();
  mocks.fetchProjects.mockRejectedValue(new Error("unavailable"));
  const refresh = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "刷新");
  await act(async () => refresh?.click());
  expect(container.textContent).toContain("行政项目摘要暂时不可用");
  expect(mocks.fetchProjectAnalyticsCount).not.toHaveBeenCalled();
});

it("ignores an older statistics response after refresh", async () => {
  let resolveOld!: (value: unknown) => void;
  mocks.fetchProjectAnalyticsCount.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      })
  );
  await renderHome();
  const refresh = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "刷新");
  await act(async () => refresh?.click());
  await act(async () =>
    resolveOld([{ id: "admin-project", open_issues: 99, done_issues: 99, last_activity_at: "2026-10-12T00:00:00Z" }])
  );
  expect(container.textContent).toContain("未完成 3 项");
  expect(container.textContent).not.toContain("未完成 99 项");
});
