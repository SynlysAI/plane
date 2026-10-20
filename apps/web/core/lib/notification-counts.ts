/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { ENotificationTab, type TNotificationTab } from "@plane/constants";
import type { TNotification, TUnreadNotificationsCount } from "@plane/types";

type TUnreadCountOperation = "increment" | "decrement";

/**
 * Return the count represented by the inbox badge.
 *
 * @param counts Server-backed unread notification counts.
 * @returns Total unread count and whether any of them are mentions.
 */
export function getNotificationBadgeState(counts: TUnreadNotificationsCount): {
  count: number;
  hasMentions: boolean;
} {
  return {
    count: Math.max(0, counts.total_unread_notifications_count),
    hasMentions: counts.mention_unread_notifications_count > 0,
  };
}

/**
 * Apply a local unread count adjustment without mutating the input counts.
 *
 * @param counts Current unread notification counts.
 * @param operation Whether to increment or decrement.
 * @param amount Number of notifications being changed.
 * @param isMentioned Whether the changed notification belongs to the mentions tab.
 * @returns Next unread count state.
 */
export function adjustUnreadNotificationsCount(
  counts: TUnreadNotificationsCount,
  operation: TUnreadCountOperation,
  amount = 1,
  isMentioned = false
): TUnreadNotificationsCount {
  const validAmount = Math.max(0, Math.abs(amount));
  const delta = operation === "increment" ? validAmount : -validAmount;

  return {
    total_unread_notifications_count: Math.max(0, counts.total_unread_notifications_count + delta),
    mention_unread_notifications_count: isMentioned
      ? Math.max(0, counts.mention_unread_notifications_count + delta)
      : counts.mention_unread_notifications_count,
  };
}

/**
 * Determine whether a notification belongs to the selected inbox tab.
 *
 * @param notification Notification displayed by the inbox.
 * @param tab Currently selected notification tab.
 * @returns True when the notification should be visible in the tab.
 */
export function isNotificationInTab(
  notification: Pick<TNotification, "is_mentioned_notification">,
  tab: TNotificationTab
): boolean {
  return tab === ENotificationTab.MENTIONS ? Boolean(notification.is_mentioned_notification) : true;
}

/**
 * Build a workspace-specific SWR key for unread notification counts.
 *
 * @param workspaceSlug Currently active workspace slug.
 * @returns Stable SWR key, or null when no workspace is active.
 */
export function workspaceUnreadNotificationKey(workspaceSlug: string | undefined): string | null {
  return workspaceSlug ? `WORKSPACE_UNREAD_NOTIFICATION_COUNT_${workspaceSlug}` : null;
}
