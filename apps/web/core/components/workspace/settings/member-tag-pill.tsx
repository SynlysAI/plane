import type { IWorkspaceMemberTag } from "@plane/types";

const TAG_COLOR_CLASS_NAMES: Record<IWorkspaceMemberTag["color"], string> = {
  sage: "border-[#BDCCBF] bg-[#F0F5F0] text-[#466152]",
  sand: "border-[#D8CBB6] bg-[#FAF6EE] text-[#75624B]",
  slate: "border-[#C8CED3] bg-[#F2F4F5] text-[#53616B]",
  mist: "border-[#C7D3D4] bg-[#F0F5F5] text-[#456467]",
  clay: "border-[#D9C4B9] bg-[#FAF2EE] text-[#815E50]",
  moss: "border-[#C7D1B5] bg-[#F3F6ED] text-[#5B6B47]",
};

type MemberTagPillSize = "display" | "control";

/**
 * 获取成员标签的统一颜色与尺寸样式。
 *
 * Args:
 *   tag: 成员标签配置。
 *   selected: 是否处于选中态；列表展示始终视为选中色。
 *   size: display 用于紧凑列表，control 用于可点击弹窗标签。
 *
 * Returns:
 *   组合后的标签样式类名。
 */
export function getMemberTagClassNames(tag: IWorkspaceMemberTag, selected = true, size: MemberTagPillSize = "display") {
  const sizeClassNames = size === "display" ? "px-1.5 py-0.5 text-11" : "px-2.5 py-1.5 text-12";
  const stateClassNames = selected
    ? TAG_COLOR_CLASS_NAMES[tag.color]
    : "border-subtle text-secondary hover:bg-surface-2";

  return `inline-flex items-center gap-1 rounded-md border focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-accent-primary ${sizeClassNames} ${stateClassNames}`;
}

type MemberTagPillProps = {
  tag: IWorkspaceMemberTag;
  className?: string;
};

/** 以统一的低饱和样式展示成员标签。 */
export function MemberTagPill({ tag, className = "" }: MemberTagPillProps) {
  return <span className={`${getMemberTagClassNames(tag)} ${className}`}>{tag.name}</span>;
}
