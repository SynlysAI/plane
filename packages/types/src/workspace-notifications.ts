/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ENotificationFilterType } from "./enums";
import type { IUserLite } from "./users";

// filters
export type TNotificationFilter = {
  type: {
    [key in ENotificationFilterType]: boolean;
  };
  snoozed: boolean;
  archived: boolean;
  read: boolean;
};

// notification payload
export type TNotificationIssueLite = {
  id: string | undefined;
  sequence_id: number | undefined;
  identifier: string | undefined;
  name: string | undefined;
  state_name: string | undefined;
  state_group: string | undefined;
};

export type TNotificationData = {
  issue: TNotificationIssueLite | undefined;
  issue_activity: {
    id: string | undefined;
    actor: string | undefined;
    field: string | undefined;
    issue_comment: string | undefined;
    verb: "created" | "updated" | "deleted";
    new_value: string | undefined;
    old_value: string | undefined;
  };
};

export type TNotification = {
  id: string;
  title: string | undefined;
  data: TNotificationData | undefined;
  announcement_details: TSystemAnnouncement | undefined;
  entity_identifier: string | undefined;
  entity_name: string | undefined;
  message_html: string | undefined;
  message: undefined;
  message_stripped: undefined;
  sender: string | undefined;
  receiver: string | undefined;
  triggered_by: string | undefined;
  triggered_by_details: IUserLite | undefined;
  read_at: string | undefined;
  archived_at: string | undefined;
  snoozed_till: string | undefined;
  is_inbox_issue: boolean | undefined;
  is_mentioned_notification: boolean | undefined;
  workspace: string | undefined;
  project: string | undefined;
  created_at: string | undefined;
  updated_at: string | undefined;
  created_by: string | undefined;
  updated_by: string | undefined;
};

export type TSystemAnnouncement = {
  id: string;
  workspace: string | undefined;
  title: string;
  body: string;
  recipient_count: number;
  published_at: string | undefined;
  idempotency_key: string | undefined;
  created_by: string | undefined;
  created_by_details: IUserLite | undefined;
  created_at: string | undefined;
  updated_at: string | undefined;
  delivery_status: "published" | "pending";
};

// notification paginated information
export type TNotificationPaginatedInfoQueryParams = {
  type?: string | undefined;
  snoozed?: boolean;
  archived?: boolean;
  mentioned?: boolean;
  read?: boolean;
  per_page?: number;
  cursor?: string;
};

export type TNotificationPaginatedInfo = {
  next_cursor: string | undefined;
  prev_cursor: string | undefined;
  next_page_results: boolean | undefined;
  prev_page_results: boolean | undefined;
  total_pages: number | undefined;
  extra_stats: string | undefined;
  count: number | undefined; // current paginated results count
  total_count: number | undefined; // total available results count
  results: TNotification[] | undefined;
  grouped_by: string | undefined;
  sub_grouped_by: string | undefined;
};

export type TSystemAnnouncementPaginatedInfo = Omit<TNotificationPaginatedInfo, "results"> & {
  results: TSystemAnnouncement[] | undefined;
};

// notification count
export type TUnreadNotificationsCount = {
  total_unread_notifications_count: number;
  mention_unread_notifications_count: number;
};

export type TNotificationLite = {
  workspace_slug: string | undefined;
  project_id: string | undefined;
  notification_id: string | undefined;
  issue_id: string | undefined;
  is_inbox_issue: boolean | undefined;
};

// unified inbox
export type TInboxActor = {
  id: string;
  display_name: string;
  avatar_url: string | null | undefined;
};

export type TInboxItemKind = "notification" | "todo" | "reminder" | "system";

export type TInboxItemCategory = "mention" | "todo" | "approval" | "review" | "work_item" | "system";

export type TInboxUrgency = "OVERDUE" | "DUE_TODAY" | "DUE_SOON" | "NORMAL";

export type TInboxItem = {
  id: string;
  schema_version: "inbox.v1";
  kind: TInboxItemKind;
  category: TInboxItemCategory;
  source: string;
  object_id: string;
  entity_name: string;
  entity_identifier: string | undefined;
  dedupe_key: string;
  title: string;
  summary: string | undefined;
  actor: TInboxActor | undefined;
  action: string | undefined;
  route: string | undefined;
  due_at: string | undefined;
  urgency: TInboxUrgency | undefined;
  status: string | undefined;
  business_status: string | undefined;
  handling_status: string | undefined;
  next_action: string | undefined;
  created_at: string;
  updated_at: string;
  read_at: string | undefined;
  archived_at: string | undefined;
  snoozed_till: string | undefined;
};

export type TInboxTab = "all" | "mentions" | "todos" | "approvals" | "reviews" | "system";

export type TInboxListParams = {
  tab?: TInboxTab;
  read?: "all" | "true" | "false";
  archived?: boolean;
  snoozed?: boolean;
  per_page?: number;
  cursor?: string;
};

export type TInboxUnreadCounts = {
  total_unread_count: number;
  mention_unread_count: number;
  todo_unread_count: number;
  approval_unread_count: number;
  review_unread_count: number;
  work_item_unread_count: number;
  system_unread_count: number;
};

export type TInboxActionResponse = {
  schema_version: "inbox.v1";
  results: TInboxItem[];
  unread_counts: TInboxUnreadCounts;
  degraded_sources: string[];
};

export type TInboxPaginatedInfo = {
  schema_version: "inbox.v1";
  results: TInboxItem[];
  count: number;
  total_count: number;
  next_cursor: string | undefined;
  unread_counts: TInboxUnreadCounts;
  degraded_sources: string[];
};
