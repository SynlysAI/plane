/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

const PENDING_NAV_STORAGE_KEY = "__plane_pending_nav";
/** 跳转意图的有效期，超时后不再用于陈旧资源恢复。 */
const PENDING_NAV_MAX_AGE_MS = 10_000;

type TPendingNavigation = {
  target: string;
  recordedAt: number;
};

/** 记录最近一次站内跳转意图，供部署更新后的陈旧资源恢复使用。 */
export const recordPendingNavigation = (target: string): void => {
  try {
    sessionStorage.setItem(
      PENDING_NAV_STORAGE_KEY,
      JSON.stringify({ target, recordedAt: Date.now() } satisfies TPendingNavigation)
    );
  } catch {
    // sessionStorage 不可用（如隐私模式）时静默降级为原地刷新。
  }
};

/**
 * 读取并清除最近的站内跳转意图。
 *
 * Returns:
 *   有效期内的目标路径；缺失、格式非法或已过期时返回 null。
 */
export const consumePendingNavigation = (): string | null => {
  try {
    const raw = sessionStorage.getItem(PENDING_NAV_STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(PENDING_NAV_STORAGE_KEY);
    const pending = JSON.parse(raw) as Partial<TPendingNavigation>;
    if (typeof pending.target !== "string" || !pending.target.startsWith("/") || pending.target.startsWith("//")) {
      return null;
    }
    const recordedAt = Number(pending.recordedAt);
    if (!Number.isFinite(recordedAt) || Date.now() - recordedAt > PENDING_NAV_MAX_AGE_MS) return null;
    return pending.target;
  } catch {
    return null;
  }
};

/** 判断链接是否为同源路径链接。 */
const isInternalHref = (href: string): boolean => href.startsWith("/") && !href.startsWith("//");

/**
 * 安装全局捕获阶段点击记录器，记录最近一次普通左键点击的站内 `<a href>`。
 * 覆盖 React Router Link、ControlLink 与原生锚点，供路由 chunk 失效时恢复到目标页。
 *
 * Returns:
 *   卸载函数，测试环境用于清理监听。
 */
export const installPendingNavigationClickRecorder = (): (() => void) => {
  const handleClick = (event: MouseEvent) => {
    // 修饰键点击交给浏览器新开标签，不属于当前页面的跳转意图。
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    const href = anchor?.getAttribute("href");
    if (!href || !isInternalHref(href)) return;
    recordPendingNavigation(href);
  };
  document.addEventListener("click", handleClick, true);
  return () => document.removeEventListener("click", handleClick, true);
};
