/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import type { TInboxActionResponse, TInboxListParams, TInboxPaginatedInfo, TInboxUnreadCounts } from "@plane/types";
// services
import { APIService } from "@/services/api.service";

export type TInboxItemAction = "read" | "unread" | "archive" | "unarchive" | "snooze";

export class InboxService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  /** Fetch one unified inbox page for notifications and actionable todos. */
  async fetchInbox(workspaceSlug: string, params: TInboxListParams = {}): Promise<TInboxPaginatedInfo | undefined> {
    const { data } = await this.get(`/api/workspaces/${workspaceSlug}/users/inbox/`, { params });
    return data || undefined;
  }

  /** Fetch badge counts using the same projection as the inbox list. */
  async fetchUnreadCounts(workspaceSlug: string): Promise<TInboxUnreadCounts | undefined> {
    const { data } = await this.get(`/api/workspaces/${workspaceSlug}/users/inbox/unread/`);
    return data || undefined;
  }

  /** Update one item without changing its underlying business object. */
  async updateItem(
    workspaceSlug: string,
    itemId: string,
    action: TInboxItemAction,
    payload: { snoozed_till?: string } = {}
  ): Promise<TInboxActionResponse | undefined> {
    const { data } = await this.post(
      `/api/workspaces/${workspaceSlug}/users/inbox/items/${encodeURIComponent(itemId)}/${action}/`,
      payload
    );
    return data || undefined;
  }

  /** Mark all active items read while leaving open business todos intact. */
  async markAllRead(workspaceSlug: string): Promise<TInboxActionResponse | undefined> {
    const { data } = await this.post(`/api/workspaces/${workspaceSlug}/users/inbox/mark-all-read/`);
    return data || undefined;
  }
}

const inboxService = new InboxService();

export default inboxService;
