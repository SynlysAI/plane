/** Isolated browser fixture for the bento home workbench; no real account is used. */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { TranslationProvider } from "@plane/i18n";
import { StoreProvider } from "@/lib/store-context";
import { WorkspaceHomeWorkbench } from "../../core/components/home/workbench";
import { ResearchChainService } from "../../core/services/research/chain.service";
import { ResearchPlatformService } from "../../core/services/research/platform.service";
import { ResearchReportService } from "../../core/services/research/report.service";
import { ResearchTodoService } from "../../core/services/research/research-todo.service";
import { ProjectService } from "../../core/services/project/project.service";
import { WorkspaceService } from "../../core/services/workspace.service";
import type { TResearchIdentity } from "@plane/types";
// oxlint-disable-next-line import/no-unassigned-import -- fixture stylesheet
import "./research-home-workbench.fixture.css";

const now = new Date("2026-10-10T15:00:00.000Z").toISOString();
const identity = {
  module_enabled: true,
  workspace_enabled: true,
  sections: { org: false, reports: true, approvals: false, research_chain: true },
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
ResearchChainService.prototype.getChains = async () => [
  {
    schema_version: "research-chain.v1",
    id: "chain-1",
    project: "project-1",
    project_name: "催化剂界面失活机理研究",
    workspace: "isolated-test",
    owner: "student-1",
    owner_name: "隔离学生",
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
ResearchReportService.prototype.getSummary = async () => ({
  period_key: "2026-W41",
  period_start: "2026-10-05",
  period_end: "2026-10-11",
  org_unit: null,
  org_unit_name: null,
  counts: { not_submitted: 3, draft: 1, submitted: 5, needs_revision: 2, accepted: 8 },
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
  ] as never;
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
      </MemoryRouter>
    </TranslationProvider>
  </StoreProvider>
);
