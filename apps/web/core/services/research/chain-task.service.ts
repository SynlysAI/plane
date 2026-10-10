/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL, researchEndpoints } from "@plane/constants";
import type {
  TResearchAssignableUser,
  TResearchChainNodeTask,
  TResearchChainNodeTaskCreatePayload,
  TResearchChainNodeTaskUpdatePayload,
} from "@plane/types";
import { APIService } from "@/services/api.service";

type TResearchEnvelope<T> = {
  success: boolean;
  data: T;
  error: unknown;
  request_id: string | null;
  schema_version: string;
};

export type TResearchChainTaskAction = "submit" | "return" | "complete" | "cancel";

export type TResearchChainTaskActionPayload = {
  reason?: string;
  comment?: string;
};

/** Generate a best-effort client request id for task idempotency. */
function request_id() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Read a research API envelope or throw the server-provided error body. */
function unwrap<T>(response: unknown): T {
  const payload = response as TResearchEnvelope<T> | undefined;
  if (!payload?.data) throw payload ?? {};
  return payload.data;
}

/** Service for the Phase 1.6 Research Chain node-task collaboration API. */
export class ResearchChainTaskService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getNodeTasks(workspaceSlug: string, chainId: string, nodeId: string) {
    return this.get(researchEndpoints.chainNodeTasks(workspaceSlug, chainId, nodeId))
      .then((response) => {
        const payload = response?.data as TResearchEnvelope<TResearchChainNodeTask[]> | undefined;
        return payload?.data ?? [];
      })
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async getAssignableUsers(workspaceSlug: string, chainId: string) {
    return this.get(researchEndpoints.chainAssignableUsers(workspaceSlug, chainId))
      .then((response) => {
        const payload = response?.data as TResearchEnvelope<TResearchAssignableUser[]> | undefined;
        return payload?.data ?? [];
      })
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async createNodeTask(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    payload: TResearchChainNodeTaskCreatePayload
  ) {
    return this.post(researchEndpoints.chainNodeTasks(workspaceSlug, chainId, nodeId), {
      ...payload,
      request_id: request_id(),
    })
      .then((response) => unwrap<TResearchChainNodeTask>(response?.data))
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async updateNodeTask(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    payload: TResearchChainNodeTaskUpdatePayload
  ) {
    return this.patch(researchEndpoints.chainNodeTask(workspaceSlug, chainId, nodeId, taskId), payload)
      .then((response) => unwrap<TResearchChainNodeTask>(response?.data))
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async runNodeTaskAction(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    taskId: string,
    action: TResearchChainTaskAction,
    payload: TResearchChainTaskActionPayload = {}
  ) {
    return this.post(researchEndpoints.chainNodeTaskAction(workspaceSlug, chainId, nodeId, taskId, action), {
      ...payload,
      request_id: request_id(),
    })
      .then((response) => unwrap<TResearchChainNodeTask>(response?.data))
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }
}
