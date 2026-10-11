/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL, researchEndpoints } from "@plane/constants";
import type { TResearchTodoEnvelopeList, TResearchTodoScope } from "@plane/types";
import { APIService } from "@/services/api.service";

export type TResearchTodoListParams = {
  scope?: TResearchTodoScope;
  limit?: number;
  cursor?: string;
};

/** Service for the read-only server-side research todo projection. */
export class ResearchTodoService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  /**
   * Read one aggregate todo page from the server.
   *
   * Args:
   *   workspaceSlug: Workspace owning the todo projection.
   *   params: Optional scope, page size and cursor filters.
   *
   * Returns:
   *   The versioned todo envelope list and degraded source metadata.
   */
  async getResearchTodos(
    workspaceSlug: string,
    params: TResearchTodoListParams = {}
  ): Promise<TResearchTodoEnvelopeList> {
    return this.get(researchEndpoints.researchTodos(workspaceSlug), { params })
      .then((response) => response?.data as TResearchTodoEnvelopeList)
      .catch((error) => {
        const response = error?.response;
        if (response?.data) {
          throw { ...(response.data as Record<string, unknown>), status: response.status };
        }
        throw error;
      });
  }
}
