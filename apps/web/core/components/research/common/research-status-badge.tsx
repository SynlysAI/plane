/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { ReactNode } from "react";
import { Badge, type TBadgeSize, type TBadgeVariant } from "@plane/propel/badge";
import { cn } from "@plane/utils";

/**
 * 科研状态字典：把 Chain、节点、审批、报告、Agent、集成等实体状态统一映射到
 * propel Badge 的低饱和语义色。同一状态在列表、详情、审批与 Trace 中保持同形同色。
 */
const STATUS_VARIANTS: Record<string, TBadgeVariant> = {
  // 草稿与未开始
  draft: "neutral",
  not_started: "neutral",
  paused: "neutral",
  archived: "neutral",
  withdrawn: "neutral",
  cancelled: "neutral",
  unknown: "neutral",
  unavailable: "neutral",
  revoked: "neutral",
  // 进行中与待处理
  active: "brand",
  in_progress: "brand",
  submitted: "warning",
  pending: "warning",
  pending_review: "warning",
  in_review: "warning",
  waiting: "warning",
  waiting_human: "warning",
  waiting_approval: "warning",
  needs_revision: "danger",
  degraded: "warning",
  medium: "warning",
  // 完成与成功
  accepted: "success",
  approved: "success",
  completed: "success",
  passed: "success",
  published: "success",
  ok: "success",
  pass: "success",
  low: "success",
  // 失败与阻断
  failed: "danger",
  rejected: "danger",
  error: "danger",
  blocked: "danger",
  down: "danger",
  sync_failed: "danger",
  high: "danger",
  // 待办严重性
  blocking: "danger",
  confirmation: "warning",
  reminder: "brand",
  syncing: "neutral",
  // 科研来源标记
  agent_source: "brand",
  // 实验 / 文献 / 成果扩展状态
  planned: "neutral",
  running: "brand",
  collected: "neutral",
  screened: "brand",
  included: "success",
  excluded: "danger",
};

/**
 * 解析科研实体状态的统一 Badge 语义色。
 *
 * Args:
 *   status: 实体原始状态值（大小写不敏感；未知状态回退 neutral）。
 *
 * Returns:
 *   propel Badge variant。
 */
export function researchStatusVariant(status: string | null | undefined): TBadgeVariant {
  return STATUS_VARIANTS[String(status ?? "").toLowerCase()] ?? "neutral";
}

type TResearchStatusBadgeProps = {
  /** 实体原始状态值，用于查字典确定语义色。 */
  status: string | null | undefined;
  /** 已翻译的状态文案。 */
  children: ReactNode;
  /** Badge 尺寸，列表行建议 sm，详情页建议 base。 */
  size?: TBadgeSize;
  /** 追加样式类。 */
  className?: string;
};

/** 科研统一状态标签：基于 propel Badge 与科研状态字典渲染。 */
export function ResearchStatusBadge({ status, children, size = "base", className }: TResearchStatusBadgeProps) {
  return (
    <span className={cn("inline-flex", className)}>
      <Badge variant={researchStatusVariant(status)} size={size}>
        {children}
      </Badge>
    </span>
  );
}
