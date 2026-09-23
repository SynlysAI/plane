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

export type TResearchKnowledgeBase = {
  external_id: string;
  title: string;
  summary?: string;
};

export type TResearchChainUpload = {
  id: string;
  status: "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "DEGRADED";
  knowledge_id: string;
  knowledge_base_id: string;
  file_name: string;
  error_code: string;
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

  async getKnowledgeBases(workspaceSlug: string, chainId: string) {
    return this.get(researchEndpoints.chainKnowledgeBases(workspaceSlug, chainId))
      .then((res) => {
        const payload = res?.data as { items?: TResearchKnowledgeBase[]; degraded?: boolean } | undefined;
        return { items: payload?.items ?? [], degraded: Boolean(payload?.degraded) };
      })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async uploadKnowledgeFile(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    knowledgeBaseId: string,
    file: File
  ) {
    const form = new FormData();
    form.append("node_id", nodeId);
    form.append("kb_id", knowledgeBaseId);
    form.append("file", file);
    return this.post(researchEndpoints.chainUploads(workspaceSlug, chainId), form, {
      headers: { "X-Request-Id": request_id() },
    })
      .then((res) => res?.data as { data: TResearchChainUpload; degraded?: boolean })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async getKnowledgeUpload(workspaceSlug: string, chainId: string, uploadId: string) {
    return this.get(researchEndpoints.chainUploadDetail(workspaceSlug, chainId, uploadId))
      .then((res) => res?.data as { data: TResearchChainUpload; degraded?: boolean })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async getKnowledgeUploads(workspaceSlug: string, chainId: string, nodeId: string) {
    return this.get(researchEndpoints.chainUploads(workspaceSlug, chainId), { params: { node_id: nodeId } })
      .then((res) => res?.data as { data: TResearchChainUpload[] })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async confirmKnowledgeReference(
    workspaceSlug: string,
    chainId: string,
    nodeId: string,
    upload: TResearchChainUpload
  ) {
    return this.post(
      researchEndpoints.chainReferences(workspaceSlug, chainId),
      {
        request_id: request_id(),
        node_id: nodeId,
        knowledge_id: upload.knowledge_id,
        kb_id: upload.knowledge_base_id,
        title: upload.file_name,
      },
      { headers: { "X-Request-Id": request_id() } }
    )
      .then((res) => res?.data)
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }
}
