import { EUserProjectRoles } from "@plane/types";

import { useProject } from "@/hooks/store/use-project";
import { useWorkspaceContext } from "@/hooks/use-workspace-context";

/**
 * 判断当前用户是否被指定行政项目的配置锁定拦截。
 *
 * Args:
 *   projectId: 项目 ID；缺失时视为未锁定。
 *
 * Returns:
 *   需要隐藏或禁用模块、标签、视图配置入口时为 true。
 */
export function useAdministrativeSettingsLock(projectId?: string): boolean {
  const { context } = useWorkspaceContext();
  const { getProjectById } = useProject();
  const project = projectId ? getProjectById(projectId) : undefined;
  if (!project) return false;
  const isAdministrativeProject = project?.is_research_project === false;
  const isProjectAdministrator = Boolean(project?.member_role && project.member_role >= EUserProjectRoles.ADMIN);
  const canBypassLock = Boolean(
    isProjectAdministrator || context?.user?.is_workspace_admin || context?.user?.is_system_admin
  );

  return Boolean(project?.administrative_settings_admin_only && isAdministrativeProject && !canBypassLock);
}
