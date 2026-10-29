import { useProject } from "@/hooks/store/use-project";
import { useWorkspaceContext } from "@/hooks/use-workspace-context";

/**
 * 判断当前用户是否被行政项目配置锁定拦截。
 *
 * Args:
 *   projectId: 可选项目 ID；未提供时按工作区共享资源配置判断。
 *
 * Returns:
 *   需要隐藏或禁用模块、标签、视图配置入口时为 true。
 */
export function useAdministrativeSettingsLock(projectId?: string): boolean {
  const { context } = useWorkspaceContext();
  const { getProjectById } = useProject();
  const project = projectId ? getProjectById(projectId) : undefined;
  const isAdministrativeProject = projectId ? project?.is_research_project === false : true;
  const canBypassLock = Boolean(context?.user?.is_workspace_admin || context?.user?.is_system_admin);

  return Boolean(context?.workspace?.administrative_settings_admin_only && isAdministrativeProject && !canBypassLock);
}
