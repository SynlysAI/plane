/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL, researchEndpoints } from "@plane/constants";
import type { TResearchChainEvent, TResearchPaperReview, TResearchPaperReviewVersion } from "@plane/types";
import { APIService } from "@/services/api.service";

type TResearchEnvelope<T> = {
  success: boolean;
  data: T;
  error: unknown;
  request_id: string | null;
  schema_version: string;
};

type TPaperPresignPayload = {
  file_name: string;
  content_type: string;
  size: number;
  sha256: string;
};

type TPaperPresignResponse = {
  asset_id: string;
  upload_data: { url: string; fields: Record<string, string> };
};

/** Generate the idempotency key expected by every paper mutation. */
function request_id() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Read a research envelope or throw the server-provided error body. */
function unwrap<T>(response: unknown): T {
  const payload = response as TResearchEnvelope<T> | undefined;
  if (!payload?.data) throw payload ?? {};
  return payload.data;
}

/** Service for the Phase 1.6 paper review collaboration API. */
export class ResearchPaperReviewService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getPaperReviews(workspaceSlug: string, chainId: string, nodeId: string) {
    return this.get(researchEndpoints.paperReviews(workspaceSlug, chainId, nodeId))
      .then((response) => {
        const payload = response?.data as TResearchEnvelope<TResearchPaperReview[]> | undefined;
        return payload?.data ?? [];
      })
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async getPaperReview(workspaceSlug: string, reviewId: string) {
    return this.get(researchEndpoints.paperReview(workspaceSlug, reviewId))
      .then((response) => unwrap<TResearchPaperReview>(response?.data))
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async getPaperChainEvents(workspaceSlug: string, nodeId: string) {
    return this.get(researchEndpoints.chainNodeEvents(workspaceSlug, nodeId))
      .then((response) => {
        const payload = response?.data as TResearchEnvelope<TResearchChainEvent[]> | undefined;
        return payload?.data ?? [];
      })
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async presignPaperVersion(workspaceSlug: string, reviewId: string, payload: TPaperPresignPayload) {
    return this.post(researchEndpoints.paperReviewVersionPresign(workspaceSlug, reviewId), payload)
      .then((response) => unwrap<TPaperPresignResponse>(response?.data))
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /**
   * Upload a paper file through the presigned storage slot.
   *
   * Args:
   *   workspaceSlug: Workspace owning the paper review.
   *   reviewId: Review that will receive the next immutable version.
   *   file: File selected by the submitter.
   *   sha256: Hex-encoded file digest validated by the backend.
   *
   * Returns:
   *   The registered asset id, ready to be bound by submitPaperVersion.
   */
  async uploadPaperVersion(workspaceSlug: string, reviewId: string, file: File, sha256: string) {
    const slot = await this.presignPaperVersion(workspaceSlug, reviewId, {
      file_name: file.name,
      content_type: file.type || "application/octet-stream",
      size: file.size,
      sha256,
    });
    const formData = new FormData();
    Object.entries(slot.upload_data.fields ?? {}).forEach(([key, value]) => formData.append(key, value));
    formData.append("file", file);
    const uploaded = await fetch(slot.upload_data.url, { method: "POST", body: formData });
    if (!uploaded.ok) throw { error_code: "paper_upload_failed" };
    return slot.asset_id;
  }

  async submitPaperVersion(
    workspaceSlug: string,
    reviewId: string,
    payload: { asset_id: string; change_summary: string }
  ) {
    return this.post(researchEndpoints.paperReviewVersions(workspaceSlug, reviewId), {
      ...payload,
      request_id: request_id(),
    })
      .then((response) => unwrap<TResearchPaperReviewVersion>(response?.data))
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async returnPaperVersion(workspaceSlug: string, reviewId: string, versionNo: number, payload: { comment: string }) {
    return this.paperVersionAction(workspaceSlug, reviewId, versionNo, "return", payload);
  }

  async acceptPaperVersion(workspaceSlug: string, reviewId: string, versionNo: number, payload: { comment?: string }) {
    return this.paperVersionAction(workspaceSlug, reviewId, versionNo, "accept", payload);
  }

  async withdrawPaperReview(workspaceSlug: string, reviewId: string, reason: string) {
    return this.post(researchEndpoints.paperReviewWithdraw(workspaceSlug, reviewId), {
      reason,
      request_id: request_id(),
    })
      .then((response) => unwrap<TResearchPaperReview>(response?.data))
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async getPaperAssetUrl(workspaceSlug: string, assetId: string) {
    return this.get(researchEndpoints.workspaceAssetDetail(workspaceSlug, assetId))
      .then((response) => (response?.data as { asset_url?: string } | undefined)?.asset_url ?? "")
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /**
   * Run a latest-version decision without letting the caller bypass the action map.
   *
   * Args:
   *   workspaceSlug: Workspace owning the review.
   *   reviewId: Review containing the version.
   *   versionNo: Latest immutable version number.
   *   action: Server-supported return or accept action.
   *   payload: Required return comment or optional acceptance comment.
   *
   * Returns:
   *   The serialized version after the server decision.
   */
  private async paperVersionAction(
    workspaceSlug: string,
    reviewId: string,
    versionNo: number,
    action: "return" | "accept",
    payload: { comment?: string }
  ) {
    return this.post(researchEndpoints.paperReviewVersionAction(workspaceSlug, reviewId, versionNo, action), {
      ...payload,
      request_id: request_id(),
    })
      .then((response) => unwrap<TResearchPaperReviewVersion>(response?.data))
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }
}
