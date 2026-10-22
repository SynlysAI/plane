/** Isolated browser fixture for the shared research todo entry; no real account is used. */
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { TranslationProvider } from "@plane/i18n";
import type { TResearchIdentity } from "@plane/types";
import { StoreProvider } from "@/lib/store-context";
import WorkspaceApprovalsPage from "../../app/(all)/[workspaceSlug]/(projects)/approvals/page";
import { WorkspaceHomeWorkbench } from "../../core/components/home/workbench";
import { ResearchChainService } from "../../core/services/research/chain.service";
import { ResearchPlatformService } from "../../core/services/research/platform.service";
import { ResearchReportService } from "../../core/services/research/report.service";
import { ProjectService } from "../../core/services/project/project.service";
import { WorkspaceService } from "../../core/services/workspace.service";
// oxlint-disable-next-line import/no-unassigned-import -- fixture stylesheet
import "../../styles/globals.css";

const now = new Date("2026-10-11T07:00:00.000Z").toISOString();
const identity = {
  module_enabled: true,
  workspace_enabled: true,
  research_ia_v2: true,
  sections: {
    org: false,
    reports: true,
    approvals: true,
    stages: true,
    research_chain: true,
  },
  user: {
    id: "student-1",
    is_workspace_admin: false,
    is_research_owner: true,
    org_units: [],
    mentor_ids: [],
    mentee_ids: [],
  },
  capabilities: {
    level: "RESEARCHER",
    nav: ["reviews", "reports", "approvals"],
    is_mentor: false,
    is_main_pi: false,
    is_stage_reviewer: false,
    management: {
      workspace: false,
      organization: false,
      integrations: false,
      operations: false,
      accounts: false,
    },
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
    next_due_at: "2026-10-12T09:30:00.000Z",
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
WorkspaceService.prototype.fetchWorkspaceRecents = async () => [];

/** Render one isolated entry so browser validation can switch between home and approvals. */
function SharedTodoFixture() {
  const [view, setView] = useState<"home" | "approvals">("approvals");
  return (
    <StoreProvider>
      <TranslationProvider>
        <MemoryRouter initialEntries={["/isolated-test/approvals?domain=shared_todos&todo_scope=to_me"]}>
          <Routes>
            <Route
              path="/:workspaceSlug/approvals"
              element={
                <main className="min-h-screen bg-canvas p-6">
                  <div className="mb-4 flex gap-2">
                    <button type="button" onClick={() => setView("home")} aria-pressed={view === "home"}>
                      首页入口
                    </button>
                    <button type="button" onClick={() => setView("approvals")} aria-pressed={view === "approvals"}>
                      审批中心入口
                    </button>
                  </div>
                  {view === "home" ? (
                    <WorkspaceHomeWorkbench workspaceSlug="isolated-test" />
                  ) : (
                    <WorkspaceApprovalsPage />
                  )}
                </main>
              }
            />
          </Routes>
        </MemoryRouter>
      </TranslationProvider>
    </StoreProvider>
  );
}

createRoot(document.getElementById("root")!).render(<SharedTodoFixture />);
