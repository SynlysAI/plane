/** 个人后端配置变化只使对应工作区的 Dock 可用性缓存失效。 */
export const BACKEND_AVAILABILITY_CHANGED = "plane:agent-backend-availability-changed";

/** 通知当前页面中的 Dock 重新检查后端连接和治理状态。 */
export function invalidateBackendAvailability(workspaceSlug: string) {
  window.dispatchEvent(new CustomEvent(BACKEND_AVAILABILITY_CHANGED, { detail: { workspaceSlug } }));
}
