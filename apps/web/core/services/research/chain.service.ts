/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { API_BASE_URL, researchEndpoints } from "@plane/constants";
import type { TResearchChain, TResearchChainNode } from "@plane/types";
import { APIService } from "@/services/api.service";

type TResearchEnvelope<T> = {
  success: boolean;
  data: T;
  error: unknown;
  request_id: string | null;
  schema_version: string;
};

export class ResearchChainService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getChains(workspaceSlug: string) {
    return this.get(researchEndpoints.chains(workspaceSlug))
      .then((res) => {
        const payload = res?.data as TResearchEnvelope<TResearchChain[]> | undefined;
        return payload?.data ?? [];
      })
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async getChainNodes(workspaceSlug: string, chainId: string) {
    return this.get(researchEndpoints.chainNodes(workspaceSlug, chainId))
      .then((res) => {
        const payload = res?.data as TResearchEnvelope<TResearchChainNode[]> | undefined;
        return payload?.data ?? [];
      })
      .catch((err) => {
        throw err?.response?.data;
      });
  }
}
