/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import useSWR from "swr";
// plane imports
import type { TInboxListParams } from "@plane/types";
// services
import inboxService from "@/services/inbox.service";

export const INBOX_REFRESH_INTERVAL = 45_000;

/** Build a stable list key so the popover and full page share one cache. */
export function inboxListKey(workspaceSlug: string | undefined, params: TInboxListParams) {
  return workspaceSlug ? `UNIFIED_INBOX_${workspaceSlug}_${JSON.stringify(params)}` : null;
}

/** Build the stable badge-count key used by the top navigation. */
export function inboxUnreadCountKey(workspaceSlug: string | undefined) {
  return workspaceSlug ? `UNIFIED_INBOX_UNREAD_${workspaceSlug}` : null;
}

/** Fetch one unified inbox page with shared polling behavior. */
export function useInboxList(workspaceSlug: string | undefined, params: TInboxListParams) {
  return useSWR(inboxListKey(workspaceSlug, params), () => inboxService.fetchInbox(workspaceSlug!, params), {
    refreshInterval: INBOX_REFRESH_INTERVAL,
    revalidateOnFocus: true,
  });
}

/** Fetch unified unread counts for the top-navigation badge. */
export function useInboxUnreadCounts(workspaceSlug: string | undefined) {
  return useSWR(
    inboxUnreadCountKey(workspaceSlug),
    workspaceSlug ? () => inboxService.fetchUnreadCounts(workspaceSlug) : null,
    {
      refreshInterval: INBOX_REFRESH_INTERVAL,
      revalidateOnFocus: true,
    }
  );
}
