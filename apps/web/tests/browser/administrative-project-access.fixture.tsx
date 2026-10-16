/** 在服务边界模拟权限响应，使用真实列表和权限组件验收，不连接业务数据库。 */
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { runInAction } from "mobx";
import { MemoryRouter, Route, Routes } from "react-router";
import { SWRConfig } from "swr";
import { setLanguage, TranslationProvider } from "@plane/i18n";
import type { IWorkspace, IWorkspaceMemberMe, TProject, TProjectMembership } from "@plane/types";
import { ProjectCardList } from "@/components/project/card-list";
import { StoreProvider, store } from "@/lib/store-context";
import { ProjectAuthWrapper } from "@/layouts/auth-layout/project-wrapper";
import { ProjectService } from "@/services/project/project.service";
import { ProjectMemberService } from "@/services/project/project-member.service";
// oxlint-disable-next-line import/no-unassigned-import -- 隔离页面使用应用样式
import "../../styles/globals.css";

const params = new URLSearchParams(window.location.search);
const manager = params.get("identity") === "manager";
const staleRole = params.get("identity") === "stale";
const direct = params.get("view") === "direct";
const workspaceSlug = "isolated-membership";
const projectId = "administrative-project";
const project = {
  id: projectId,
  name: "行政项目权限验收",
  identifier: "ADM",
  workspace: "workspace-1",
  members: [],
  member_role: 20,
  is_research_project: false,
  archived_at: null,
  network: 2,
  logo_props: {},
  sort_order: 0,
  created_at: "2026-10-12T00:00:00Z",
  updated_at: "2026-10-12T00:00:00Z",
} as unknown as TProject;

/** 模拟后端已经过滤成员权限的列表响应。 */
ProjectService.prototype.getProjects = async () => (manager ? [project] : []);

/** 模拟无成员的详情拒绝，验证缓存角色不能绕过接口结果。 */
ProjectService.prototype.getProject = async () => {
  throw { status: 403, data: { code: "PROJECT_MEMBERSHIP_REQUIRED" } };
};

/** 模拟尚未失效的旧角色缓存，详情拒绝仍须阻止内容渲染。 */
ProjectMemberService.prototype.projectMemberMe = async () =>
  ({ role: staleRole ? 20 : undefined }) as TProjectMembership;

store.router.setQuery({ workspaceSlug, projectId });
runInAction(() => {
  store.workspaceRoot.workspaces = {
    "workspace-1": { id: "workspace-1", slug: workspaceSlug, name: "隔离工作区" } as IWorkspace,
  };
  store.user.permission.workspaceUserInfo[workspaceSlug] = {
    role: staleRole || manager ? 20 : 15,
  } as IWorkspaceMemberMe;
  store.user.permission.workspaceProjectsPermissions[workspaceSlug] = staleRole ? { [projectId]: 20 } : {};
  if (staleRole) store.projectRoot.project.projectMap[projectId] = project;
});

/** 渲染真实项目列表或直接链接的权限包装组件。 */
function AdministrativeProjectAccessFixture() {
  useEffect(() => {
    if (!direct) void store.projectRoot.project.fetchProjects(workspaceSlug);
  }, []);

  return (
    <StoreProvider>
      <TranslationProvider>
        <SWRConfig value={{ shouldRetryOnError: false, revalidateOnFocus: false }}>
          <MemoryRouter initialEntries={[`/${workspaceSlug}/projects/${projectId}/issues`]}>
            <Routes>
              <Route
                path="/:workspaceSlug/projects/:projectId/issues"
                element={
                  <main className="h-screen bg-canvas p-6">
                    {direct ? (
                      <ProjectAuthWrapper workspaceSlug={workspaceSlug} projectId={projectId}>
                        <p>不应显示的项目任务</p>
                      </ProjectAuthWrapper>
                    ) : (
                      <ProjectCardList />
                    )}
                  </main>
                }
              />
            </Routes>
          </MemoryRouter>
        </SWRConfig>
      </TranslationProvider>
    </StoreProvider>
  );
}

await setLanguage("zh-CN");
createRoot(document.getElementById("root")!).render(<AdministrativeProjectAccessFixture />);
