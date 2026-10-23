"use client";

import type { ReactNode } from "react";
// plane imports
import { cn } from "@plane/utils";

/** 极简与常规两种首页信息密度。所有卡片都自然展开，由页面承担完整滚动。 */
export type THomeDensity = "compact" | "detailed";

type Props = {
  /** 卡片标题，同时作为无障碍标签。 */
  title: string;
  /** 标题下方的弱化说明文案。 */
  hint?: string;
  /** 标题行右侧的入口链接或轻量操作。 */
  action?: ReactNode;
  /** 固定在卡片底部的计数或入口。 */
  footer?: ReactNode;
  /** 当前首页显示密度，用于统一紧凑/详细的呼吸感。 */
  density: THomeDensity;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
};

/**
 * 首页工作台统一卡片骨架。卡片不设固定高度、不做内部截断，启用较多控件时保持自然长页面浏览。
 *
 * Args:
 *   title: 卡片标题文本。
 *   hint: 可选的弱化副标题。
 *   action: 标题行右侧入口。
 *   footer: 卡片底部计数或链接。
 *   density: 显示密度；compact 减少纵向留白，detailed 提供更宽松的阅读节奏。
 *   className: 追加到卡片根元素的类名（用于网格跨度）。
 *   bodyClassName: 追加到内容区的类名。
 *   children: 卡片内容。
 */
export function HomeSectionCard({ title, hint, action, footer, density, className, bodyClassName, children }: Props) {
  return (
    <section
      aria-label={title}
      className={cn("flex min-w-0 flex-col overflow-hidden rounded-xl bg-surface-2", className)}
    >
      <header
        className={cn(
          "flex shrink-0 flex-wrap items-start justify-between gap-3 px-4",
          density === "compact" ? "py-3" : "py-4"
        )}
      >
        <div className="min-w-0">
          <h2 className={cn("font-semibold text-primary", density === "compact" ? "text-14" : "text-15")}>{title}</h2>
          {hint && <p className="mt-0.5 text-11 text-tertiary">{hint}</p>}
        </div>
        {action}
      </header>
      <div className={cn("min-h-0 flex-1 border-t border-subtle", bodyClassName)}>{children}</div>
      {footer && <footer className="shrink-0 border-t border-subtle px-4 py-2 text-11 text-tertiary">{footer}</footer>}
    </section>
  );
}
