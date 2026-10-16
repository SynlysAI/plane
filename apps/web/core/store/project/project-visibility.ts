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

/**
 * 判断项目是否允许自行加入；行政项目必须由管理员配置成员。
 * @param project 项目类型、成员角色和归档状态。
 * @returns 仅未加入且未归档的科研项目允许自行加入。
 */
export function projectCanBeJoined(project: {
  is_research_project?: boolean;
  member_role?: unknown;
  archived_at?: string | null;
}) {
  return project.is_research_project === true && !project.member_role && !project.archived_at;
}
