"use client";

import type { ReactNode } from "react";
// plane imports
import { cn } from "@plane/utils";

/** 紧凑与详细两种首页信息密度。 */
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
  /** primary 为首行主卡，secondary 为次行卡片；仅影响紧凑模式高度。 */
  size?: "primary" | "secondary";
  /** 是否使用固定卡片布局并让内容区内部滚动。 */
  fixedLayout?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
};

/**
 * 首页工作台统一卡片骨架。固定布局在卡片内滚动，非固定布局自然展开。
 *
 * Args:
 *   title: 卡片标题文本。
 *   hint: 可选的弱化副标题。
 *   action: 标题行右侧入口。
 *   footer: 卡片底部计数或链接。
 *   density: 显示密度，控制留白与紧凑模式高度档位。
 *   size: 紧凑模式下的卡片高度档位。
 *   fixedLayout: 是否固定卡片布局并让内容区内部滚动。
 *   className: 追加到卡片根元素的类名（用于网格跨度）。
 *   bodyClassName: 追加到内容区的类名。
 *   children: 卡片内容。
 */
export function HomeSectionCard({
  title,
  hint,
  action,
  footer,
  density,
  size = "secondary",
  fixedLayout = false,
  className,
  bodyClassName,
  children,
}: Props) {
  const isScrollable = fixedLayout;

  return (
    <section
      aria-label={title}
      className={cn(
        "workspace-content-inset flex min-w-0 flex-col overflow-hidden rounded-xl bg-surface-2",
        density === "compact" &&
          fixedLayout &&
          (size === "primary" ? "max-xl:h-[400px] xl:h-full xl:min-h-0" : "max-xl:h-[320px] xl:h-full xl:min-h-0"),
        className
      )}
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
      {/* data-home-card-scroll 是与 HomeActivityWidget 分页哨兵之间的 DOM 契约：
          activity.tsx 通过 closest("[data-home-card-scroll='true']") 反查该滚动容器，
          并将其作为 IntersectionObserver 的 root。调整卡片结构时必须保留该属性与滚动行为。 */}
      <div
        data-home-card-scroll={isScrollable ? "true" : undefined}
        className={cn(
          "min-h-0 flex-1 border-t border-subtle",
          isScrollable && "overflow-y-auto overscroll-contain",
          bodyClassName
        )}
      >
        {children}
      </div>
      {footer && <footer className="shrink-0 border-t border-subtle px-4 py-2 text-11 text-tertiary">{footer}</footer>}
    </section>
  );
}
