/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL, researchEndpoints } from "@plane/constants";
import type { TFeedbackStatus, TResearchFeedback, TResearchFeedbackListResponse } from "@plane/types";
import { APIService } from "@/services/api.service";

export type TResearchFeedbackFilters = {
  page?: number | string;
  page_size?: number | string;
  feedback_type?: string;
  status?: string;
  module?: string;
  q?: string;
  date_from?: string;
  date_to?: string;
  scope?: string;
};

export class ResearchFeedbackService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  /**
   * Read own or managed feedback from the Plane API.
   *
   * Args:
   *   workspaceSlug: Workspace identifier.
   *   params: List filters and pagination parameters.
   *
   * Returns:
   *   The paginated feedback payload.
   */
  async list(workspaceSlug: string, params: TResearchFeedbackFilters = {}) {
    return this.get(researchEndpoints.feedback(workspaceSlug), { params })
      .then((response) => response?.data?.data as TResearchFeedbackListResponse)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /**
   * Submit a feedback form with optional screenshot files.
   *
   * Args:
   *   workspaceSlug: Workspace identifier.
   *   form: Multipart form containing feedback fields and files.
   *
   * Returns:
   *   The created feedback record.
   */
  async create(workspaceSlug: string, form: FormData) {
    return this.post(researchEndpoints.feedback(workspaceSlug), form)
      .then((response) => response?.data?.data as TResearchFeedback)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /**
   * Update a feedback status and return the complete record.
   *
   * Args:
   *   workspaceSlug: Workspace identifier.
   *   feedbackId: Feedback record identifier.
   *   payload: New status and mandatory handling comment.
   *
   * Returns:
   *   The updated feedback record.
   */
  async updateStatus(workspaceSlug: string, feedbackId: string, payload: { status: TFeedbackStatus; comment: string }) {
    return this.patch(researchEndpoints.feedbackStatus(workspaceSlug, feedbackId), payload)
      .then((response) => response?.data?.data as TResearchFeedback)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  /** Build an authenticated same-origin screenshot URL.
   *
   * Args:
   *   workspaceSlug: Workspace identifier.
   *   feedbackId: Feedback record identifier.
   *   screenshotId: Screenshot registration identifier.
   *   manage: Whether the management scope query is required.
   *
   * Returns:
   *   Absolute URL to the Plane feedback screenshot endpoint.
   */
  screenshotUrl(workspaceSlug: string, feedbackId: string, screenshotId: string, manage = false) {
    const endpoint = researchEndpoints.feedbackScreenshot(workspaceSlug, feedbackId, screenshotId);
    return `${API_BASE_URL}${endpoint}${manage ? "?scope=manage" : ""}`;
  }
}
