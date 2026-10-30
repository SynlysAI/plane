/** Isolated browser fixture for theme preferences and the workspace background shell. */
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { action } from "mobx";
import { ThemeProvider } from "next-themes";
import { TranslationProvider, initPromise, setLanguage } from "@plane/i18n";
import { applyCustomTheme } from "@plane/utils";
import type { IProject } from "@plane/types";
import { StoreProvider, store } from "@/lib/store-context";
import { ProfileSettingsContent } from "../../core/components/settings/profile/content/root";
import { ProfileSettingsModal } from "../../core/components/settings/profile/modal";
import { WorkspaceBackgroundShell } from "../../core/components/workspace/background-shell";
import { WorkspaceHomeWorkbench } from "../../core/components/home/workbench";
import { ProjectCardList } from "../../core/components/project/card-list";
import { WORKSPACE_BACKGROUND_IMAGES } from "../../helpers/workspace-backgrounds";
import { WorkspaceService } from "../../core/services/workspace.service";
import { ProjectDomainsService } from "../../core/services/project-domains.service";
import { ProjectService } from "../../core/services/project/project.service";
// oxlint-disable-next-line import/no-unassigned-import -- fixture stylesheet
import "./workspace-background.fixture.css";

const params = new URLSearchParams(window.location.search);
const backgroundMode = params.get("mode") === "light" ? "light" : "dark";
const savedTheme = JSON.parse(localStorage.getItem("fixture-background-theme") || "null");
const pageView = params.get("view") ?? "settings";
const fixtureProject = {
  id: "fixture-project",
  workspace: "fixture-workspace",
  name: "仪器设备协作",
  identifier: "LAB",
  description: "实验室仪器共享与维护",
  is_research_project: false,
  members: [],
  member_role: 15,
  network: 0,
  archived_at: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-30T00:00:00Z",
  cover_image_url: WORKSPACE_BACKGROUND_IMAGES[2],
  logo_props: { in_use: "icon", icon: { name: "science", color: "#426b67" } },
} as unknown as IProject;

action(() => {
  store.user.userProfile.data = {
    ...store.user.userProfile.data,
    id: "fixture-profile",
    theme: {
      theme: "custom",
      primary: "#426b67",
      background: backgroundMode === "light" ? "#f7f7f5" : "#1a1a1a",
      darkPalette: backgroundMode === "dark",
      backgroundImage: WORKSPACE_BACKGROUND_IMAGES[2],
      ...savedTheme,
    },
  };
  store.router.setQuery({ workspaceSlug: "lab" });
  store.projectRoot.project.projectMap[fixtureProject.id] = fixtureProject;
  store.projectRoot.project.loader = "loaded";
  store.projectRoot.project.fetchStatus = "complete";
  if (pageView === "modal") {
    store.commandPalette.toggleProfileSettingsModal({ isOpen: true, activeTab: "preferences" });
  }
  store.research.identityWorkspaceSlug = "lab";
  store.research.identity = {
    module_enabled: false,
    workspace_enabled: false,
    sections: { org: false, reports: false, approvals: false },
    user: {
      id: "fixture",
      is_workspace_admin: false,
      is_research_owner: false,
      org_units: [],
      mentor_ids: [],
      mentee_ids: [],
    },
    identity: { provider: null, subject: null, employee_id: null, configured: false },
  };
})();

// 首页使用隔离数据，验收过程中不请求真实工作区。
WorkspaceService.prototype.fetchWorkspaceWidgets = async () => [
  { key: "my_todos", is_enabled: true, config: { size: "medium" }, sort_order: 1100 },
  { key: "administrative_projects", is_enabled: true, config: { size: "small" }, sort_order: 900 },
  { key: "recent_activity", is_enabled: true, config: { size: "small" }, sort_order: 800 },
  { key: "workbench_layout", is_enabled: true, config: { density: "compact" }, sort_order: 100 },
];
WorkspaceService.prototype.fetchWorkspaceActivities = async () => ({
  results: [],
  next_offset: null,
  has_more: false,
  offset: 0,
  per_page: 12,
});
ProjectDomainsService.prototype.todos = async () => ({
  results: [],
  total_count: 0,
  next_cursor: null,
  degraded_sources: [],
});
ProjectService.prototype.getProjects = async () => [fixtureProject];
ProjectService.prototype.getProjectAnalyticsCount = async () => [];

// 偏好仅保存到隔离 fixture 的 localStorage，不向生产 API 写入数据。
store.user.userProfile.userService.updateCurrentUserProfile = async (data) => {
  if (params.get("fail") === "1") throw new Error("fixture-save-failed");
  localStorage.setItem("fixture-background-theme", JSON.stringify(data.theme));
  return { ...store.user.userProfile.data, theme: data.theme };
};

/** 渲染真实偏好控件及页面承载面，供桌面和移动端背景回归使用。 */
function Fixture() {
  useEffect(() => {
    const theme = store.user.userProfile.data.theme;
    if (theme.theme === "custom") {
      applyCustomTheme(theme.primary, theme.background, theme.darkPalette ? "dark" : "light");
    }
  }, []);

  return (
    <ThemeProvider
      attribute="data-theme"
      themes={["light", "dark", "light-contrast", "dark-contrast", "custom"]}
      defaultTheme={savedTheme?.theme ?? backgroundMode}
      storageKey="fixture-background-mode"
    >
      <TranslationProvider>
        <StoreProvider>
          <WorkspaceBackgroundShell>
            <div className="flex size-full gap-2 overflow-hidden p-2">
              <aside className="hidden w-56 shrink-0 flex-col gap-2 rounded-lg border border-subtle bg-surface-1 p-4 md:flex">
                <div className="text-h6-medium text-primary">项目</div>
                <div className="rounded border border-subtle bg-layer-1 px-3 py-2 text-body-sm-regular text-secondary">
                  侧边栏
                </div>
              </aside>
              <main className="workspace-content-surface flex min-w-0 flex-1 flex-col overflow-y-auto rounded-lg border border-subtle bg-surface-1 p-4 md:p-6">
                {pageView === "settings" ? (
                  <ProfileSettingsContent activeTab="preferences" className="w-full" />
                ) : pageView === "home" ? (
                  <WorkspaceHomeWorkbench workspaceSlug="lab" />
                ) : (
                  <>
                    <h1 className="text-22 mb-4 font-semibold text-primary">行政项目</h1>
                    <ProjectCardList totalProjectIds={[fixtureProject.id]} filteredProjectIds={[fixtureProject.id]} />
                  </>
                )}
              </main>
            </div>
          </WorkspaceBackgroundShell>
          <ProfileSettingsModal />
        </StoreProvider>
      </TranslationProvider>
    </ThemeProvider>
  );
}

void initPromise.then(async () => {
  await setLanguage("zh-CN");
  createRoot(document.getElementById("root")!).render(
    <MemoryRouter initialEntries={["/lab"]}>
      <Routes>
        <Route path="/:workspaceSlug" element={<Fixture />} />
      </Routes>
    </MemoryRouter>
  );
  return undefined;
});
