/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TResearchIdentity } from "@plane/types";

export const RESEARCH_OVERVIEW_ROW_LIMIT = 5;

const DIRECTION_ROLES = new Set(["OWNER", "PI"]);

type TOverviewChain = {
  owner: string;
  owner_name?: string;
};

/**
 * 判断查看者是不是直接导师、方向负责人或主 PI。
 */
export function isResearchOverviewSupervisor(identity: TResearchIdentity | null | undefined): boolean {
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
 * 查看者不是所有者时返回已有显示名，否则不写名字。
 */
export function chainOwnerLabel(identity: TResearchIdentity | null | undefined, chain: TOverviewChain): string {
  const viewerId = identity?.user?.id;
  if (!viewerId || chain.owner === viewerId) return "";
  return chain.owner_name?.trim() ?? "";
}
