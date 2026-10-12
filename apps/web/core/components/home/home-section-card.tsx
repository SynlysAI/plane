"use client";

import type { ReactNode } from "react";
// plane imports
import { cn } from "@plane/utils";

/** 紧凑模式使用固定高度与内部滚动，详细模式自然展开由页面滚动。 */
export type THomeDensity = "compact" | "detailed";

type Props = {
  /** 卡片标题，同时作为无障碍标签的默认值。 */
  title: string;
  /** 标题下方的弱化说明文案。 */
  hint?: string;
  /** 标题行右侧的入口链接或轻量操作。 */
  action?: ReactNode;
  /** 固定在卡片底部的计数或入口。 */
  footer?: ReactNode;
  /** 当前首页显示密度，决定卡片是否固定高度。 */
  density: THomeDensity;
  /** primary 为主卡（第一行），secondary 为辅卡（第二行）；仅决定窄屏固定高度。 */
  size?: "primary" | "secondary";
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
};

/**
 * 首页工作台统一卡片骨架：固定标题区、可滚动内容区与固定底栏。
 * 宽屏紧凑模式下卡片拉伸到网格行，随视口填满剩余高度；窄屏保持固定高度。
 *
 * Args:
 *   title: 卡片标题文本。
 *   hint: 可选的弱化副标题。
 *   action: 标题行右侧入口。
 *   footer: 卡片底部计数或链接。
 *   density: 显示密度；compact 时内容区滚动，detailed 时自然展开。
 *   size: 窄屏固定高度档位，仅 compact 模式生效。
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
  className,
  bodyClassName,
  children,
}: Props) {
  return (
    <section
      aria-label={title}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-xl bg-surface-2",
        density === "compact" &&
          (size === "primary" ? "max-xl:h-[400px] xl:h-full xl:min-h-0" : "max-xl:h-[320px] xl:h-full xl:min-h-0"),
        className
      )}
    >
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-14 font-semibold text-primary">{title}</h2>
          {hint && <p className="mt-0.5 text-11 text-tertiary">{hint}</p>}
        </div>
        {action}
      </header>
      <div
        className={cn(
          "min-h-0 flex-1 border-t border-subtle",
          density === "compact" && "overflow-y-auto overscroll-contain",
          bodyClassName
        )}
      >
        {children}
      </div>
      {footer && <footer className="shrink-0 border-t border-subtle px-4 py-2 text-11 text-tertiary">{footer}</footer>}
    </section>
  );
}
