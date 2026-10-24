/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL, researchEndpoints } from "@plane/constants";
import type { TFeedbackStatus, TResearchFeedback, TResearchFeedbackListResponse } from "@plane/types";
import { APIService } from "@/services/api.service";

type TResearchFeedbackFilters = {
  page?: number | string;
  page_size?: number | string;
  feedback_type?: string;
  status?: string;
  module?: string;
  q?: string;
  date_from?: string;
  date_to?: string;
  scope?: TResearchFeedbackScope;
};

type TResearchFeedbackScope = "own" | "workspace" | "manage";

export class ResearchFeedbackService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  /**
   * Read own, workspace-wide, or managed feedback from the Plane API.
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

  /**
   * Create a feedback reply authorized by the backend.
   *
   * Args:
   *   workspaceSlug: Workspace identifier.
   *   feedbackId: Feedback record identifier.
   *   content: Reply body submitted by an operations account or manager.
   *
   * Returns:
   *   The updated feedback record containing all replies.
   */
  async createReply(workspaceSlug: string, feedbackId: string, payload: { content: string }) {
    return this.post(researchEndpoints.feedbackReply(workspaceSlug, feedbackId), payload)
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
   *   scope: Feedback visibility scope used for screenshot authorization.
   *
   * Returns:
   *   Absolute URL to the Plane feedback screenshot endpoint.
   */
  screenshotUrl(
    workspaceSlug: string,
    feedbackId: string,
    screenshotId: string,
    scope: TResearchFeedbackScope = "own"
  ) {
    const endpoint = researchEndpoints.feedbackScreenshot(workspaceSlug, feedbackId, screenshotId);
    return `${API_BASE_URL}${endpoint}${scope === "own" ? "" : `?scope=${scope}`}`;
  }
}
