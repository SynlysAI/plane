/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TLogoProps } from "./common";
import type { TIssuePriorities } from "./issues";

export type TRecentActivityFilterKeys = "all item" | "issue" | "page" | "project" | "workspace_page";
export type TWorkbenchWidgetKey =
  | "my_todos"
  | "research_projects"
  | "administrative_projects"
  | "recent_activity"
  | "report_summary";

export type TWorkbenchLayoutKey = "workbench_layout";

export type THomeWidgetKeys =
  | TWorkbenchWidgetKey
  | TWorkbenchLayoutKey
  | "quick_links"
  | "recents"
  | "my_stickies"
  | "quick_tutorial"
  | "new_at_plane";

/**
 * 首页工作台布局模式：aggregate 为自动填满的聚合网格，waterfall 为整行单模块页签。
 */
export type TWorkbenchLayoutMode = "aggregate" | "waterfall";

/**
 * @deprecated 旧首页偏好中的卡片宽度档位。新布局由模式与模块数量自动计算，仅用于兼容已保存配置。
 */
export type THomeWidgetSize = "small" | "medium" | "large" | "full";

export type THomeWorkbenchDensity = "compact" | "detailed";

export type THomeActivityChange = {
  field?: string | null;
  old_value?: string | null;
  new_value?: string | null;
};

export type THomeActivityActor = {
  id: string;
  display_name: string | null;
  avatar_url?: string | null;
  is_bot?: boolean;
};

export type THomeActivityProject = {
  id: string;
  name: string;
  identifier: string;
} | null;

export type THomeActivity = {
  id: string;
  source: "project" | "work_item" | "comment" | "research";
  actor: THomeActivityActor | null;
  action: string;
  entity_type: string;
  entity_id: string;
  entity_name: string;
  project?: THomeActivityProject;
  url?: string | null;
  occurred_at: string;
  changes: THomeActivityChange[];
  summary?: string;
};

export type THomeActivityResponse = {
  results: THomeActivity[];
  next_cursor?: string | null;
  /** Legacy offset pagination field retained for existing API clients. */
  next_offset?: number | null;
  has_more: boolean;
  offset?: number;
  per_page: number;
};

export type THomeWidgetProps = {
  workspaceSlug: string;
};

export type TPageEntityData = {
  id: string;
  name: string;
  logo_props: TLogoProps;
  project_id?: string;
  owned_by: string;
  project_identifier?: string;
};

export type TProjectEntityData = {
  id: string;
  name: string;
  logo_props: TLogoProps;
  project_members: string[];
  identifier: string;
};

export type TIssueEntityData = {
  id: string;
  name: string;
  state: string;
  priority: TIssuePriorities;
  assignees: string[];
  type: string | null;
  sequence_id: number;
  project_id: string;
  project_identifier: string;
  is_epic: boolean;
};

export type TActivityEntityData = {
  id: string;
  entity_name: "page" | "project" | "issue" | "workspace_page";
  entity_identifier: string;
  visited_at: string;
  entity_data: TPageEntityData | TProjectEntityData | TIssueEntityData;
};

export type TLinkEditableFields = {
  title: string;
  url: string;
};

export type TLink = TLinkEditableFields & {
  created_by_id: string;
  id: string;
  metadata: any;
  workspace_slug: string;

  //need
  created_at: Date;
};

export type TLinkMap = {
  [workspace_slug: string]: TLink;
};

export type TLinkIdMap = {
  [workspace_slug: string]: string[];
};

export type TWidgetEntityData = {
  key: THomeWidgetKeys;
  name?: string;
  is_enabled: boolean;
  config?: Record<string, unknown>;
  sort_order: number;
};
