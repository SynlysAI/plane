/** Isolated browser fixture for the bento home workbench; no real account is used. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { setLanguage, TranslationProvider } from "@plane/i18n";
import { StoreProvider } from "@/lib/store-context";
import { WorkspaceHomeWorkbench } from "../../core/components/home/workbench";
import { ResearchChainService } from "../../core/services/research/chain.service";
import { ResearchPlatformService } from "../../core/services/research/platform.service";
import { ResearchReportService } from "../../core/services/research/report.service";
import { ProjectDomainsService } from "../../core/services/project-domains.service";
import { ProjectService } from "../../core/services/project/project.service";
import { WorkspaceService } from "../../core/services/workspace.service";
import type { TResearchChain, TResearchIdentity } from "@plane/types";
// oxlint-disable-next-line import/no-unassigned-import -- fixture stylesheet
import "./research-home-workbench.fixture.css";

const now = new Date().toISOString();
const role = new URLSearchParams(window.location.search).get("role") ?? "admin";
const canResearch = role === "admin" || role === "researcher";
const canSummary = role === "admin" || role === "summary";

/** 将 fixture 的本地日期格式化为后端报告周期边界。 */
function formatFixtureDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const identity = {
  module_enabled: true,
  workspace_enabled: true,
  sections: { org: false, reports: true, approvals: false, research_chain: canResearch },
  capabilities: {
    level: role === "admin" ? "ADMIN" : canSummary ? "MENTOR" : canResearch ? "RESEARCHER" : "NONE",
    nav: [...(canResearch ? ["research_chain"] : []), ...(canSummary ? ["summary"] : [])],
    is_mentor: false,
    is_main_pi: false,
    is_stage_reviewer: false,
    management: { workspace: false, organization: false, integrations: false, operations: false, accounts: false },
  },
  user: {
    id: "student-1",
    is_workspace_admin: false,
    is_research_owner: true,
    org_units: [],
    mentor_ids: [],
    mentee_ids: [],
  },
  identity: {
    provider: null,
    subject: null,
    employee_id: null,
    configured: false,
  },
  workspace: {
    slug: "isolated-test",
    purpose: "GENERAL",
    report_timezone: "Asia/Shanghai",
  },
} as TResearchIdentity;

ResearchPlatformService.prototype.getIdentity = async () => identity;
const browserChains: TResearchChain[] = [
  {
    schema_version: "research-chain.v1",
    id: "chain-1",
    project: "project-1",
    project_name: "催化剂界面失活机理研究与多尺度反应动力学联合实验的长期科研项目",
    workspace: "isolated-test",
    owner: "student-1",
    owner_name: "隔离学生与联合实验负责人长姓名显示验证",
    status: "ACTIVE",
    visibility: "ORG",
    open_task_count: 3,
    next_due_at: "2026-10-11T09:30:00.000Z",
    current_node: {
      id: "node-1",
      title: "实验数据分析",
      status: "WAITING_HUMAN",
      node_type: "ANALYSIS",
      updated_at: now,
    },
    created_at: now,
    updated_at: now,
  },
];
ResearchChainService.prototype.getChains = async () => [
  ...browserChains,
  {
    ...browserChains[0],
    id: "archived-chain",
    status: "ARCHIVED",
    project_name: "不应出现的归档课题",
    open_task_count: 99,
  },
  {
    ...browserChains[0],
    id: "deleted-chain",
    status: "DELETED",
    project_name: "不应出现的删除课题",
    open_task_count: 88,
  },
];
ProjectDomainsService.prototype.todos = async () => ({
  results: [
    {
      id: "CHAIN_TASK:task-1",
      domain: "RESEARCH",
      source: "CHAIN_TASK",
      object_id: "task-1",
      title: "补充催化剂失活实验图表",
      context: "实验数据分析",
      requester: { id: "student-1", display_name: "隔离学生" },
      assignees: [{ id: "student-1", display_name: "隔离学生" }],
      business_status: "ASSIGNED",
      handling_status: "TODO",
      next_action: "SUBMIT",
      due_at: "2026-10-10T17:30:00.000Z",
      urgency: "DUE_TODAY",
      href: "#todo-1",
      capabilities: { schema_version: "research-capabilities.v1", actions: {} },
      trace_ref: null,
      updated_at: now,
    },
  ],
  total_count: 1,
  next_cursor: null,
  degraded_sources: [],
});
/** 为浏览器验收解析显式或相对的报告周期。 */
function fixtureReportPeriod(params: { report_type?: string; period_offset?: number; period_key?: string }) {
  const reportType = params.report_type === "MONTHLY" ? "MONTHLY" : "WEEKLY";
  const periodKey =
    params.period_key ||
    (reportType === "MONTHLY"
      ? params.period_offset === -1
        ? "2026-09"
        : "2026-10"
      : params.period_offset === -1
        ? "2026-W41"
        : "2026-W42");

  if (reportType === "MONTHLY") {
    const [year, month] = periodKey.split("-").map(Number);
    const lastDay = new Date(year, month, 0).getDate();
    return {
      periodKey,
      periodStart: `${year}-${String(month).padStart(2, "0")}-01`,
      periodEnd: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
    };
  }

  const match = /^(\d{4})-W(\d{2})$/.exec(periodKey);
  const isoYear = Number(match?.[1] ?? 2026);
  const isoWeek = Number(match?.[2] ?? 42);
  const januaryFourth = new Date(isoYear, 0, 4);
  const monday = new Date(januaryFourth);
  monday.setDate(januaryFourth.getDate() - ((januaryFourth.getDay() + 6) % 7) + (isoWeek - 1) * 7);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return { periodKey, periodStart: formatFixtureDate(monday), periodEnd: formatFixtureDate(sunday) };
}

ResearchReportService.prototype.getSummary = async (_workspaceSlug, params = {}) => {
  const period = fixtureReportPeriod(params);
  return {
    period_key: period.periodKey,
    period_start: period.periodStart,
    period_end: period.periodEnd,
    org_unit: null,
    org_unit_name: null,
    counts:
      params.report_type === "MONTHLY"
        ? params.period_offset === -1
          ? { not_submitted: 92, draft: 0, submitted: 14, needs_revision: 11, accepted: 17 }
          : { not_submitted: 93, draft: 1, submitted: 15, needs_revision: 12, accepted: 18 }
        : params.period_offset === -1
          ? { not_submitted: 192, draft: 0, submitted: 4, needs_revision: 1, accepted: 7 }
          : { not_submitted: 193, draft: 1, submitted: 5, needs_revision: 2, accepted: 8 },
    pending_members: [],
  };
};
ProjectService.prototype.getProjects = async () =>
  [
    {
      id: "admin-project-1",
      name: "设备采购协作",
      identifier: "PROC",
      logo_props: { in_use: "icon", icon: {} },
      sort_order: 0,
      archived_at: null,
      workspace: "isolated-test",
      cycle_view: false,
      issue_views_view: false,
      module_view: false,
      page_view: false,
      inbox_view: false,
      is_research_project: false,
      updated_at: new Date(now),
    },
    {
      id: "admin-project-2",
      name: "实验室设备维护与耗材采购报销进度协调项目ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      archived_at: null,
      is_research_project: false,
    },
    {
      id: "admin-project-3",
      name: "历史办公协作",
      archived_at: null,
      is_research_project: false,
    },
  ] as never;
ProjectService.prototype.getProjectAnalyticsCount = async () => [
  { id: "admin-project-1", open_issues: 3, done_issues: 2, last_activity_at: "2026-10-11T08:30:00Z" },
  { id: "admin-project-2", open_issues: 12, done_issues: 8, last_activity_at: "2026-10-12T03:15:00Z" },
  { id: "admin-project-3", open_issues: 0, done_issues: 5, last_activity_at: "2025-09-01T02:00:00Z" },
];
WorkspaceService.prototype.fetchWorkspaceWidgets = async () => [
  { key: "my_todos", is_enabled: true, config: { size: "medium" }, sort_order: 1100 },
  { key: "research_projects", is_enabled: true, config: { size: "large" }, sort_order: 1000 },
  { key: "administrative_projects", is_enabled: true, config: { size: "small" }, sort_order: 900 },
  { key: "recent_activity", is_enabled: true, config: { size: "small" }, sort_order: 800 },
  { key: "report_summary", is_enabled: true, config: { size: "small" }, sort_order: 700 },
  { key: "workbench_layout", is_enabled: true, config: { density: "compact" }, sort_order: 100 },
];
WorkspaceService.prototype.updateWorkspaceWidget = async (_workspaceSlug, key, data) => ({ key, ...data });
WorkspaceService.prototype.fetchWorkspaceActivities = async () => ({
  results: [
    {
      id: "activity-1",
      source: "project",
      actor: { id: "student-1", display_name: "隔离学生" },
      action: "updated",
      entity_type: "project",
      entity_id: "admin-project-1",
      entity_name: "设备采购协作",
      project: { id: "admin-project-1", name: "设备采购协作", identifier: "PROC" },
      url: "#activity-project",
      occurred_at: now,
      changes: [{ field: "name", old_value: "旧项目名", new_value: "设备采购协作" }],
      summary: "",
    },
    {
      id: "activity-2",
      source: "research",
      actor: { id: "student-1", display_name: "隔离学生" },
      action: "report.submit",
      entity_type: "report",
      entity_id: "report-1",
      entity_name: "WEEKLY 2026-W42",
      project: { id: "project-1", name: "催化剂界面失活机理研究", identifier: "RES" },
      url: "#activity-report",
      occurred_at: now,
      changes: [{ field: "period", new_value: "2026-W42" }],
      summary: "",
    },
  ],
  next_offset: null,
  has_more: false,
  offset: 0,
  per_page: 12,
});
WorkspaceService.prototype.fetchWorkspaceRecents = async () => [
  {
    id: "recent-project",
    entity_name: "project",
    entity_identifier: "admin-project-1",
    visited_at: now,
    entity_data: {
      id: "admin-project-1",
      name: "设备采购协作",
      logo_props: { in_use: "icon", icon: {} },
      project_members: [],
      identifier: "PROC",
    },
  },
];

await setLanguage("zh-CN");
createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <TranslationProvider>
      <MemoryRouter initialEntries={["/isolated-test"]}>
        <Routes>
          <Route
            path="/:workspaceSlug"
            element={
              <main className="relative h-screen overflow-hidden bg-surface-1">
                <div className="flex h-11 items-center border-b border-subtle bg-surface-1 px-4 text-12 text-secondary">
                  首页
                </div>
                <div className="absolute inset-x-0 top-11 bottom-0 overflow-hidden">
                  <div className="h-full w-full overflow-hidden">
                    <div className="relative flex h-full w-full flex-col overflow-x-hidden overflow-y-auto bg-canvas px-page-x py-page-y">
                      <WorkspaceHomeWorkbench workspaceSlug="isolated-test" />
                    </div>
                  </div>
                </div>
              </main>
            }
          />
        </Routes>
      </MemoryRouter>
    </TranslationProvider>
  </StoreProvider>
);
