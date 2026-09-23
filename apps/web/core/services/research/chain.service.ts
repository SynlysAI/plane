/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { API_BASE_URL, researchEndpoints } from "@plane/constants";
import type {
  TResearchChain,
  TResearchChainEvent,
  TResearchChainMember,
  TResearchChainNode,
  TResearchChainNodeAction,
  TResearchChainSnapshot,
} from "@plane/types";
import { APIService } from "@/services/api.service";

type TResearchEnvelope<T> = {
  success: boolean;
  data: T;
  error: unknown;
  request_id: string | null;
  schema_version: string;
};

type TResearchChainNodeDetail = {
  node: TResearchChainNode;
  events: TResearchChainEvent[];
  snapshots: TResearchChainSnapshot[];
};

function request_id() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

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

  async getChain(workspaceSlug: string, chainId: string) {
    return this.get(researchEndpoints.chain(workspaceSlug, chainId))
      .then((res) => {
        const payload = res?.data as TResearchEnvelope<TResearchChain> | undefined;
        if (!payload?.data) throw payload ?? {};
        return payload.data;
      })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async archiveChain(workspaceSlug: string, chainId: string) {
    return this.post(researchEndpoints.chainArchive(workspaceSlug, chainId), {})
      .then((res) => {
        const payload = res?.data as TResearchEnvelope<TResearchChain> | undefined;
        if (!payload?.data) throw payload ?? {};
        return payload.data;
      })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async restoreChain(workspaceSlug: string, chainId: string) {
    return this.post(researchEndpoints.chainRestore(workspaceSlug, chainId), {})
      .then((res) => {
        const payload = res?.data as TResearchEnvelope<TResearchChain> | undefined;
        if (!payload?.data) throw payload ?? {};
        return payload.data;
      })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async getChainMembers(workspaceSlug: string, chainId: string) {
    return this.get(researchEndpoints.chainMembers(workspaceSlug, chainId))
      .then((res) => {
        const payload = res?.data as TResearchEnvelope<TResearchChainMember[]> | undefined;
        return payload?.data ?? [];
      })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async addChainMember(workspaceSlug: string, chainId: string, userId: string, role: 15 | 20 = 15) {
    return this.post(researchEndpoints.chainMembers(workspaceSlug, chainId), { user_id: userId, role })
      .then((res) => {
        const payload = res?.data as TResearchEnvelope<TResearchChainMember[]> | undefined;
        return payload?.data ?? [];
      })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async removeChainMember(workspaceSlug: string, chainId: string, userId: string) {
    return this.delete(researchEndpoints.chainMember(workspaceSlug, chainId, userId)).catch((err) => {
      throw err?.response?.data ?? err;
    });
  }

  async createChainNode(
    workspaceSlug: string,
    chainId: string,
    payload: {
      node_type: string;
      title: string;
      parent_node_id?: string;
      loop_iteration?: number;
      assignee_id?: string;
    }
  ) {
    return this.post(researchEndpoints.chainNodes(workspaceSlug, chainId), {
      ...payload,
      request_id: request_id(),
    })
      .then((res) => {
        const response = res?.data as TResearchEnvelope<TResearchChainNode> | undefined;
        if (!response?.data) throw response ?? {};
        return response.data;
      })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async getChainNodeDetail(workspaceSlug: string, nodeId: string) {
    return this.get(researchEndpoints.chainNode(workspaceSlug, nodeId))
      .then((res) => {
        const payload = res?.data as TResearchEnvelope<TResearchChainNodeDetail> | undefined;
        if (!payload?.data) throw payload ?? {};
        return payload.data;
      })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async transitionChainNode(workspaceSlug: string, nodeId: string, action: TResearchChainNodeAction, reason?: string) {
    return this.post(researchEndpoints.chainNodeTransitions(workspaceSlug, nodeId), {
      request_id: request_id(),
      action,
      ...(reason ? { reason } : {}),
    })
      .then((res) => {
        const payload = res?.data as
          | TResearchEnvelope<{
              node: TResearchChainNode;
              event: TResearchChainEvent;
            }>
          | undefined;
        if (!payload?.data) throw payload ?? {};
        return payload.data;
      })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }
}
