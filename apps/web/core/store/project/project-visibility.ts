/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/** 侧栏项目：正式成员，或研究链只读读者。归档项目不进入侧栏。 */
export function projectIsVisibleInSidebar(
  project: {
    workspace?: string | { id?: string } | null;
    member_role?: unknown;
    research_access?: "review" | null;
    archived_at?: string | null;
  },
  workspaceId: string
) {
  const workspace = typeof project.workspace === "string" ? project.workspace : project.workspace?.id;
  return (
    workspace === workspaceId && (!!project.member_role || project.research_access === "review") && !project.archived_at
  );
}
