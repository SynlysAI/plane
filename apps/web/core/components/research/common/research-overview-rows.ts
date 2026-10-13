/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TResearchChain, TResearchIdentity } from "@plane/types";

const RESEARCH_OVERVIEW_ROW_LIMIT = 5;

const DIRECTION_ROLES = new Set(["OWNER", "PI"]);

type TOverviewChain = {
  owner: string;
  owner_name?: string;
};

/**
 * 判断查看者是不是直接导师、方向负责人或主 PI。
 */
function isResearchOverviewSupervisor(identity: TResearchIdentity | null | undefined): boolean {
  if (!identity) return false;
  if (identity.capabilities?.is_main_pi || identity.user?.is_main_pi) return true;
  if (identity.capabilities?.is_mentor) return true;
  if ((identity.user?.mentee_ids?.length ?? 0) > 0) return true;
  return (identity.user?.org_units ?? []).some((unit) => DIRECTION_ROLES.has(unit.org_role));
}

/**
 * 选择总览要同时画出的课题行。
 *
 * 学生或全部课题都属于自己时只保留一行。上级最多五行，不补空行。
 */
export function selectResearchOverviewChains<T extends TOverviewChain>(
  identity: TResearchIdentity | null | undefined,
  chains: T[]
): { mode: "single" | "stacked"; rows: T[] } {
  const viewerId = identity?.user?.id;
  const ownsAll = chains.length === 0 || Boolean(viewerId && chains.every((chain) => chain.owner === viewerId));
  const stacked = isResearchOverviewSupervisor(identity) && !ownsAll;
  if (!stacked) return { mode: "single", rows: chains.slice(0, 1) };
  return { mode: "stacked", rows: chains.slice(0, RESEARCH_OVERVIEW_ROW_LIMIT) };
}

/**
 * 返回负责人显示名，包括查看者自己的项目；缺失名称时由界面提供占位文案。
 */
export function chainOwnerLabel(_identity: TResearchIdentity | null | undefined, chain: TOverviewChain): string {
  return chain.owner_name?.trim() ?? "";
}

/** 排除归档和已删除课题，使概览行与统计使用同一组项目。 */
export function visibleResearchChains(chains: TResearchChain[]): TResearchChain[] {
  return chains.filter((chain) => chain.status !== "ARCHIVED" && chain.status !== "DELETED");
}
