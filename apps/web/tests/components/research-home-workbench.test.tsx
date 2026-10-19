// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  fetchIdentity: vi.fn(),
  getChainNodes: vi.fn(),
  getKnowledgeUploads: vi.fn(),
  getResearchTodos: vi.fn(),
  fetchReportSummary: vi.fn(),
  getReportSummary: vi.fn(),
  recentWidget: vi.fn(),
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
vi.mock("@/hooks/store/use-research", () => {
  const researchStore = {
    get identity() {
      return mocks.researchIdentity;
    },
    get identityWorkspaceSlug() {
      return mocks.identityWorkspaceSlug;
    },
    canSee: (key: string) => ["research_chain", "summary"].includes(key),
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
vi.mock("@/components/home/widgets/recents", () => ({
  RecentActivityWidget: (props: unknown) => {
    mocks.recentWidget(props);
    return <div>最近动态</div>;
  },
}));

vi.mock("@/hooks/use-workspace-context", () => ({ useWorkspaceContext: () => ({ context: mocks.researchIdentity }) }));
vi.mock("@/services/project-domains.service", () => ({ ProjectDomainsService: class { todos = mocks.getResearchTodos; }, domainError: () => "请求失败" }));

const { WorkspaceHomeWorkbench } = await import("@/components/home/workbench");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderHome(initialPath = "/lab", workspaceSlug = "lab") {
  return act(async () =>
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <WorkspaceHomeWorkbench workspaceSlug={workspaceSlug} />
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
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
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
          period_key: "2026-10",
          period_start: "2026-10-01",
          period_end: "2026-10-31",
          counts: { not_submitted: 13, draft: 4, submitted: 15, needs_revision: 12, accepted: 18 },
        }
      : {
          period_key: "2026-W42",
          period_start: "2026-10-12",
          period_end: "2026-10-18",
          counts: { not_submitted: 3, draft: 1, submitted: 5, needs_revision: 2, accepted: 8 },
        }
  );
  mocks.researchIdentity.module_enabled = true;
  mocks.researchIdentity.workspace_enabled = true;
  mocks.researchIdentity.sections.research_chain = true;
  mocks.researchIdentity.sections.reports = true;
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
  expect(container.querySelector('a[href="/lab/research/chains/?view=reports"]')).not.toBeNull();
  expect(container.textContent).not.toContain("快捷入口");
  expect(container.textContent).not.toContain("我的工作");
  expect(container.textContent).not.toContain("便签");
  expect(container.textContent).not.toContain("草稿");
});

it("fills the wide viewport in compact mode and supports density switching", async () => {
  await renderHome();
  await act(async () => undefined);

  const cards = [...container.querySelectorAll('[data-testid="workspace-home-columns"] > section')];
  expect(cards.length).toBeGreaterThanOrEqual(5);
  for (const card of cards.slice(0, 5)) {
    expect(card.className).toMatch(/max-xl:h-\[(400|320)px\]/);
    expect(card.className).toMatch(/xl:h-full/);
    expect(card.className).toContain("xl:min-h-0");
    const body = card.querySelector("div.border-t");
    expect(body?.className).toContain("overflow-y-auto");
  }
  const grid = container.querySelector("[data-testid='workspace-home-columns']");
  expect(grid?.className).toContain("xl:flex-1");
  expect(grid?.className).toContain("xl:grid-rows-[minmax(0,3fr)_minmax(0,2fr)]");
  expect(grid?.parentElement?.className.split(/\s+/)).toContain("xl:h-full");

  const detailedButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "详细");
  await act(async () => detailedButton?.click());
  expect(window.localStorage.getItem("plane.home.workbench.density")).toBe("detailed");
  for (const card of cards.slice(0, 5)) {
    expect(card.className).not.toMatch(/max-xl:h-\[(400|320)px\]/);
  }
  expect(grid?.parentElement?.className.split(/\s+/)).not.toContain("xl:h-full");
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
  expect(mocks.getReportSummary).toHaveBeenCalledTimes(4);
  expect(mocks.fetchReportSummary).not.toHaveBeenCalled();
});

it("keeps weekly and monthly counts and periods separate", async () => {
  await renderHome();
  expect(mocks.getReportSummary).toHaveBeenCalledWith("lab", { report_type: "WEEKLY" });
  expect(mocks.getReportSummary).toHaveBeenCalledWith("lab", { report_type: "MONTHLY" });
  const week = container.querySelector('[role="group"][aria-label="本周"]');
  const month = container.querySelector('[role="group"][aria-label="本月"]');
  expect(week?.textContent).toContain("2026-10-12 ~ 2026-10-18");
  expect(month?.textContent).toContain("2026-10-01 ~ 2026-10-31");
  expect([...week!.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
    "未提交3",
    "需修改2",
    "已提交5",
    "已验收8",
  ]);
  expect([...month!.querySelectorAll("a")].map((link) => link.textContent)).toEqual([
    "未提交13",
    "需修改12",
    "已提交15",
    "已验收18",
  ]);
  expect(
    [...week!.querySelectorAll("a"), ...month!.querySelectorAll("a")].every(
      (link) => link.getAttribute("href") === "/lab/research/chains/?view=reports"
    )
  ).toBe(true);
  const allPeriod = [...container.querySelectorAll("button")].find((button) => button.textContent === "全部");
  await act(async () => allPeriod?.click());
  expect(mocks.getReportSummary).toHaveBeenCalledTimes(2);
});

it("places administrative recents before reports and passes scope and refresh", async () => {
  await renderHome();
  const grid = container.querySelector("[data-testid='workspace-home-columns']");
  expect([...grid!.children].slice(2).map((section) => section.getAttribute("aria-label"))).toEqual([
    "行政项目概览",
    "最近动态",
    "报告提交摘要",
  ]);
  expect(mocks.recentWidget).toHaveBeenLastCalledWith(
    expect.objectContaining({
      workspaceSlug: "lab",
      scope: "administrative",
      refreshToken: 0,
    })
  );
  const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent === "刷新");
  await act(async () => refresh?.click());
  expect(mocks.recentWidget).toHaveBeenLastCalledWith(expect.objectContaining({ refreshToken: 1 }));
});

it("retains the monthly summary when the weekly request fails", async () => {
  mocks.getReportSummary.mockRejectedValueOnce(new Error("unavailable"));
  await renderHome();
  expect(container.querySelector('[aria-label="本周"]')?.textContent).toContain("暂不可用");
  expect(container.querySelector('[aria-label="本月"]')?.textContent).toContain("已验收18");
  expect(container.querySelector('[aria-label="本周"] a')).toBeNull();
});

it("does not request or invent counts without summary permission", async () => {
  mocks.researchIdentity.sections.reports = false;
  await renderHome();
  const section = container.querySelector('section[aria-label="报告提交摘要"]');
  expect(mocks.getReportSummary).not.toHaveBeenCalled();
  expect(section).toBeNull();
});

it("retains monthly counts when the weekly summary is forbidden", async () => {
  mocks.getReportSummary.mockRejectedValueOnce({ error_code: "research_permission_denied" });
  await renderHome();
  expect(container.querySelector('[aria-label="本周"]')?.textContent).toContain("没有科研数据访问权限");
  expect(container.querySelector('[aria-label="本周"] a')).toBeNull();
  expect(container.querySelector('[aria-label="本月"]')?.textContent).toContain("已验收18");
});

it("ignores pending summaries when identity permissions change while summary access remains", async () => {
  const originalIdentity = mocks.researchIdentity;
  const pending: ((summary: unknown) => void)[] = [];
  mocks.getReportSummary.mockImplementationOnce(() => new Promise((done) => pending.push(done)));
  mocks.getReportSummary.mockImplementationOnce(() => new Promise((done) => pending.push(done)));
  try {
    await renderHome();
    mocks.researchIdentity = {
      ...originalIdentity,
      user: { ...originalIdentity.user, is_workspace_admin: true },
    };
    await renderHome();
    expect(mocks.getReportSummary).toHaveBeenCalledTimes(4);
    await act(async () => pending.forEach((done) => done({ period_key: "stale-identity", counts: {} })));
    expect(container.textContent).not.toContain("stale-identity");
    expect(container.querySelector('[aria-label="本月"]')?.textContent).toContain("已验收18");
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
  mocks.getReportSummary.mockImplementationOnce(() => new Promise((done) => pending.push(done)));
  mocks.getReportSummary.mockImplementationOnce(() => new Promise((done) => pending.push(done)));
  await renderHome();
  mocks.identityWorkspaceSlug = "other";
  await renderHome("/other", "other");
  await act(async () => pending.forEach((done) => done({ period_key: "stale-workspace", counts: {} })));
  expect(container.textContent).not.toContain("stale-workspace");
  expect(container.querySelector('[aria-label="本月"]')?.textContent).toContain("已验收18");
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
  const names = () => [...container.querySelectorAll('a[href$="/issues"]')].map((entry) => entry.textContent);
  expect(names()).toEqual(["最近项目", "同时间甲", "同时间乙", "旧项目"]);
  expect(container.textContent).not.toContain("已归档项目");
  expect(container.textContent).not.toContain("科研内部项目");
  const allPeriod = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "全部");
  await act(async () => allPeriod?.click());
  expect(names()).toEqual(["最近项目", "同时间甲", "同时间乙", "旧项目"]);
  const detailed = [...container.querySelectorAll("button")].find((entry) => entry.textContent === "详细");
  await act(async () => detailed?.click());
  expect(container.textContent).toContain("未完成 2 项");
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
