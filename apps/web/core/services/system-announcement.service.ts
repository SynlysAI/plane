/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import type {
  TSystemAnnouncement,
  TSystemAnnouncementPaginatedInfo,
  TNotificationPaginatedInfoQueryParams,
} from "@plane/types";
import { APIService } from "@/services/api.service";

export type TSystemAnnouncementPayload = {
  title: string;
  body: string;
  idempotency_key?: string;
};

export class SystemAnnouncementService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  /** Fetch announcements published by the current workspace administrator. */
  async fetchAnnouncements(
    workspaceSlug: string,
    params: TNotificationPaginatedInfoQueryParams
  ): Promise<TSystemAnnouncementPaginatedInfo | undefined> {
    const { data } = await this.get(`/api/workspaces/${workspaceSlug}/system-announcements/`, { params });
    return data || undefined;
  }

  /** Publish a workspace-wide announcement. */
  async publishAnnouncement(
    workspaceSlug: string,
    payload: TSystemAnnouncementPayload
  ): Promise<TSystemAnnouncement | undefined> {
    const { data } = await this.post(`/api/workspaces/${workspaceSlug}/system-announcements/`, payload);
    return data || undefined;
  }
}

const systemAnnouncementService = new SystemAnnouncementService();

export default systemAnnouncementService;
