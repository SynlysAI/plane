/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL, researchEndpoints } from "@plane/constants";
import type { TResearchOutcome, TResearchOutcomeAttachment } from "@plane/types";
// services
import { APIService } from "@/services/api.service";

export type TOutcomePayload = {
  title: string;
  output_type?: string;
  venue?: string;
  doi?: string;
  external_url?: string;
  authors?: string[];
  status?: string;
  published_at?: string | null;
  file_asset?: string | null;
  visibility?: string;
};

export class ResearchOutcomeService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getOutcomes(workspaceSlug: string, projectId: string) {
    return this.get(researchEndpoints.outcomes(workspaceSlug, projectId))
      .then((res) => res?.data as { results: TResearchOutcome[]; count: number })
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async createOutcome(workspaceSlug: string, projectId: string, payload: TOutcomePayload) {
    return this.post(researchEndpoints.outcomes(workspaceSlug, projectId), payload)
      .then((res) => res?.data as TResearchOutcome)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async updateOutcome(workspaceSlug: string, outcomeId: string, payload: Partial<TOutcomePayload>) {
    return this.patch(researchEndpoints.outcome(workspaceSlug, outcomeId), payload)
      .then((res) => res?.data as TResearchOutcome)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async deleteOutcome(workspaceSlug: string, outcomeId: string) {
    return this.delete(researchEndpoints.outcome(workspaceSlug, outcomeId)).catch((err) => {
      throw err?.response?.data;
    });
  }

  async getOutcomeAttachments(workspaceSlug: string, outcomeId: string) {
    return this.get(researchEndpoints.outcomeAttachments(workspaceSlug, outcomeId))
      .then((res) => res?.data as { results: TResearchOutcomeAttachment[] })
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async presignOutcomeAttachment(
    workspaceSlug: string,
    outcomeId: string,
    payload: { file_name: string; content_type: string; size: number }
  ) {
    return this.post(researchEndpoints.outcomeAttachmentPresign(workspaceSlug, outcomeId), payload)
      .then((res) => res?.data as { asset_id: string; upload_data: { url: string; fields: Record<string, string> } })
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async registerOutcomeAttachment(workspaceSlug: string, outcomeId: string, assetId: string) {
    return this.post(researchEndpoints.outcomeAttachments(workspaceSlug, outcomeId), { asset_id: assetId })
      .then((res) => res?.data as TResearchOutcomeAttachment)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async linkOutcome(workspaceSlug: string, outcomeId: string, payload: { target_type: string; target_id: string }) {
    return this.post(researchEndpoints.outcomeLinks(workspaceSlug, outcomeId), payload)
      .then((res) => res?.data as TResearchOutcome)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  exportChainUrl(workspaceSlug: string, projectId: string) {
    return researchEndpoints.chainExport(workspaceSlug, projectId);
  }
}
