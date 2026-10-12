import type { TNavigationCategory, TNavigationProject } from "@/services/research/navigation.service";

export type FlatCategory = { category: TNavigationCategory; depth: number };

/** 获取侧栏项目应打开的现有详情路由。

科研链回到课题概览，而不是默认进入节点工作台。

Args:
    workspaceSlug: 当前工作区标识。
    project: 导航树中的项目，含路由种类和可选课题 ID。

Returns:
    该项目在现有页面中的绝对路径。
 */
export function projectHref(
  workspaceSlug: string | string[],
  project: Pick<TNavigationProject, "id" | "chain_id" | "kind">
) {
  if (project.kind === "RESEARCH_CHAIN") {
    return `/${workspaceSlug}/research/chains/${project.chain_id || project.id}?tab=overview`;
  }
  if (project.kind === "LEGACY_RESEARCH") {
    return `/${workspaceSlug}/research/projects/${project.id}/stages`;
  }
  return `/${workspaceSlug}/projects/${project.id}/issues`;
}

/** 展平分类树；只保留可作为写入目标的客户自定义分类。 */
export function flattenCategories(categories: TNavigationCategory[], depth = 0): FlatCategory[] {
  return categories.flatMap((category) => [
    ...(category.kind === "CUSTOM" ? [{ category, depth }] : []),
    ...flattenCategories(category.children, depth + 1),
  ]);
}

/** 收集分类自身和全部后代，删除时禁止作为迁移目标。 */
export function collectBlockedIds(category: TNavigationCategory): Set<string> {
  const blocked = new Set([category.id]);
  category.children.forEach((child) => collectBlockedIds(child).forEach((id) => blocked.add(id)));
  return blocked;
}
