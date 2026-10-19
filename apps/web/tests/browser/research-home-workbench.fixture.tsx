/** Isolated browser fixture for the bento home workbench; no real account is used. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { TranslationProvider } from "@plane/i18n";
import { StoreProvider } from "@/lib/store-context";
import { WorkspaceHomeWorkbench } from "../../core/components/home/workbench";
import { ResearchChainService } from "../../core/services/research/chain.service";
import { ResearchPlatformService } from "../../core/services/research/platform.service";
import { ResearchReportService } from "../../core/services/research/report.service";
import { ResearchTodoService } from "../../core/services/research/research-todo.service";
import { ProjectDomainsService } from "../../core/services/project-domains.service";
import { ProjectService } from "../../core/services/project/project.service";
import { WorkspaceService } from "../../core/services/workspace.service";
import type { TResearchChain, TResearchIdentity } from "@plane/types";
// oxlint-disable-next-line import/no-unassigned-import -- fixture stylesheet
import "./research-home-workbench.fixture.css";

const now = new Date("2026-10-10T15:00:00.000Z").toISOString();
const identity = {
  module_enabled: true,
  workspace_enabled: true,
  sections: { org: false, reports: true, approvals: false, research_chain: true },
  capabilities: {
    level: "ADMIN",
    nav: ["research_chain", "summary"],
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
ResearchTodoService.prototype.getResearchTodos = async () => ({
  schema_version: "research-todo.v2",
  results: [
    {
      schema_version: "research-todo.v2",
      id: "CHAIN_TASK:task-1",
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
  count: 1,
  total_count: 1,
  next_cursor: null,
  degraded_sources: [],
});
ProjectDomainsService.prototype.todos = async () => ({
  results: [],
  total_count: 0,
  next_cursor: null,
  degraded_sources: [],
});
ResearchReportService.prototype.getSummary = async (_workspaceSlug, params = {}) => ({
  period_key:
    params.report_type === "MONTHLY"
      ? params.period_offset === -1
        ? "2026-09"
        : "2026-10"
      : params.period_offset === -1
        ? "2026-W41"
        : "2026-W42",
  period_start:
    params.report_type === "MONTHLY"
      ? params.period_offset === -1
        ? "2026-09-01"
        : "2026-10-01"
      : params.period_offset === -1
        ? "2026-10-05"
        : "2026-10-12",
  period_end:
    params.report_type === "MONTHLY"
      ? params.period_offset === -1
        ? "2026-09-30"
        : "2026-10-31"
      : params.period_offset === -1
        ? "2026-10-11"
        : "2026-10-18",
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
});
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
