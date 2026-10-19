import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { runInAction } from "mobx";
import { MemoryRouter, Route, Routes } from "react-router";
import { SWRConfig } from "swr";
import { setLanguage, TranslationProvider } from "@plane/i18n";
import type { IState, IUser, IWorkspace, IWorkspaceMemberMe, TIssue, TIssuesResponse, TProject } from "@plane/types";
import { ContentWrapper } from "@/components/core/content-wrapper";
import { AppHeader } from "@/components/core/app-header";
import { CreateMoreSwitch } from "@/components/issues/create-more-switch";
import { IssuesHeader } from "@/components/issues/header";
import { ProjectLayoutRoot } from "@/components/issues/issue-layouts/roots/project-layout-root";
import { TabNavigationRoot } from "@/components/navigation/tab-navigation-root";
import { StoreProvider, store } from "@/lib/store-context";
import { IssueService } from "@/services/issue/issue.service";
import { ProjectService } from "@/services/project/project.service";
// oxlint-disable-next-line import/no-unassigned-import -- 验收使用应用真实样式。
import "../../styles/globals.css";

const workspaceSlug = "workflow-review";
const projectId = "workflow-project";
const project = {
  id: projectId,
  workspace: "workspace",
  name: "报告材料与会议演示文稿",
  identifier: "PPT",
  member_role: 20,
  is_research_project: false,
  network: 2,
  logo_props: {},
  sort_order: 0,
  issue_views_view: false,
  cycle_view: true,
  module_view: true,
  page_view: true,
  inbox_view: true,
  archived_at: null,
  created_at: "2026-10-16T01:00:00Z",
  updated_at: "2026-10-16T01:00:00Z",
} as TProject;
const workItems = Array.from({ length: 24 }, (_, index) => ({
  id: `issue-${index + 1}`,
  name: `会议报告材料 ${String(index + 1).padStart(2, "0")}`,
  sequence_id: index + 1,
  project_id: projectId,
  workspace_id: "workspace",
  state_id: "backlog",
  state: { id: "backlog", name: "Backlog", group: "backlog", color: "#60646c" },
  priority: "none",
  assignee_ids: [],
  label_ids: [],
  module_ids: [],
  parent_id: null,
  sort_order: index,
  sub_issues_count: 0,
  attachment_count: 0,
  link_count: 0,
  created_at: "2026-10-18T01:00:00Z",
  updated_at: "2026-10-18T01:00:00Z",
  archived_at: null,
  completed_at: null,
})) as unknown as TIssue[];
const filters = {
  displayFilters: { layout: "list", group_by: null, order_by: "sort_order", show_empty_groups: false },
  displayProperties: { state: true, priority: true, key: true },
  kanbanFilters: { group_by: [], sub_group_by: [] },
};

/** 替换列表服务边界，保留真实 store、筛选和列表渲染。 */
IssueService.prototype.getIssues = async () =>
  ({
    grouped_by: "",
    next_cursor: "",
    prev_cursor: "",
    next_page_results: false,
    prev_page_results: false,
    total_count: workItems.length,
    count: workItems.length,
    total_pages: 1,
    extra_stats: null,
    results: workItems,
    total_results: workItems.length,
  }) as TIssuesResponse;
ProjectService.prototype.getProject = async () => project;
ProjectService.prototype.getProjectUserProperties = async () =>
  ({
    display_filters: filters.displayFilters,
    display_properties: filters.displayProperties,
    rich_filters: null,
  }) as never;

store.router.setQuery({ workspaceSlug, projectId });
runInAction(() => {
  store.workspaceRoot.workspaces = {
    workspace: { id: "workspace", slug: workspaceSlug, name: "验收工作区" } as IWorkspace,
  };
  store.user.data = { id: "reviewer", display_name: "验收用户" } as IUser;
  store.user.permission.workspaceUserInfo[workspaceSlug] = { role: 20 } as IWorkspaceMemberMe;
  store.user.permission.workspaceProjectsPermissions[workspaceSlug] = { [projectId]: 20 };
  store.projectRoot.project.projectMap[projectId] = project;
  store.projectRoot.project.loader = undefined;
  store.state.stateMap.backlog = {
    id: "backlog",
    name: "Backlog",
    group: "backlog",
    color: "#60646c",
    project_id: projectId,
    default: true,
  } as IState;
  store.issue.projectIssuesFilter.filters[projectId] = filters as never;
});

/** 以项目页面的真实组件复核列表滚动、项目切换和开关键盘操作。 */
function ProjectWorkflowFixture() {
  const [checked, setChecked] = useState(false);
  if (new URLSearchParams(location.search).get("view") === "controls") {
    return (
      <main className="p-4">
        <CreateMoreSwitch checked={checked} onCheckedChange={setChecked} />
        <output>{String(checked)}</output>
      </main>
    );
  }
  return (
    <main className="relative flex h-dvh min-w-0 flex-col overflow-hidden bg-surface-1 text-primary">
      <div className="h-header shrink-0 border-b border-subtle px-3">
        <TabNavigationRoot workspaceSlug={workspaceSlug} projectId={projectId} />
      </div>
      <AppHeader header={<IssuesHeader />} />
      <ContentWrapper>
        <ProjectLayoutRoot />
      </ContentWrapper>
    </main>
  );
}

await setLanguage("zh-CN");
document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <TranslationProvider>
      <SWRConfig value={{ shouldRetryOnError: false, revalidateOnFocus: false }}>
        <MemoryRouter initialEntries={[`/${workspaceSlug}/projects/${projectId}/issues`]}>
          <Routes>
            <Route path="/:workspaceSlug/projects/:projectId/issues" element={<ProjectWorkflowFixture />} />
            <Route path="/:workspaceSlug/settings/projects/:projectId" element={<p>项目设置验收</p>} />
          </Routes>
        </MemoryRouter>
      </SWRConfig>
    </TranslationProvider>
  </StoreProvider>
);
