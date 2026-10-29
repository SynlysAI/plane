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
  TResearchChainStageApproval,
  TResearchChainStageApprovalSummary,
  TResearchChainStageMaterialItem,
  TResearchChainSnapshot,
  TResearchChainUploadLimits,
} from "@plane/types";
import { notifyWorkspaceTodosUpdated } from "@/helpers/workspace-todos.helper";
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

type TResearchChainStageMaterialCreatePayload = {
  requirement_code: string;
  upload_id: string;
};

function request_id() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export type TResearchKnowledgeBase = {
  external_id: string;
  title: string;
  summary?: string;
};

type TResearchKnowledgeCandidate = {
  name: string;
  external_id: string;
  source: string;
  seen_at: string;
};

type TResearchKnowledgeRequestState =
  | "REQUESTED"
  | "PENDING_ADMIN"
  | "NEEDS_INFO"
  | "REJECTED"
  | "CREATED_PENDING_BINDING"
  | "READY"
  | "FAILED"
  | "ARCHIVED"
  | "RESTORE_PENDING"
  | "UNASSIGNED";

type TResearchKnowledgeScope = "GROUP" | "LEGACY_CHAIN" | "UNASSIGNED";

export type TResearchChainUpload = {
  id: string;
  status: "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "DEGRADED";
  knowledge_id: string;
  knowledge_base_id: string;
  file_name: string;
  file_type: string;
  file_size: number;
  preview_url?: string | null;
  download_url?: string | null;
  error_code: string;
};

export class ResearchChainService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getChains(workspaceSlug: string, params: Record<string, string> = {}) {
    return this.get(researchEndpoints.chains(workspaceSlug), { params })
      .then((res) => {
        const payload = res?.data as TResearchEnvelope<TResearchChain[]> | undefined;
        return payload?.data ?? [];
      })
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  /** 读取工作区研究链游标分页结果，供列表筛选与 URL 回放。 */
  async getChainPage(workspaceSlug: string, params: Record<string, string> = {}) {
    return this.get(researchEndpoints.chains(workspaceSlug), { params })
      .then(
        (response) =>
          response.data as {
            results: TResearchChain[];
            next_cursor: string;
            prev_cursor: string;
            next_page_results: boolean;
            prev_page_results: boolean;
          }
      )
      .catch((error) => {
        throw error?.response?.data;
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

  /** 可恢复地删除研究链及其课题，保留研究数据。 */
  async deleteChain(workspaceSlug: string, chainId: string): Promise<void> {
    await this.delete(researchEndpoints.chain(workspaceSlug, chainId)).catch((err) => {
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

  /** 读取十三阶段审批的权威状态、材料清单和审批历史。 */
  async getChainStageApprovals(workspaceSlug: string, chainId: string) {
    return this.get(researchEndpoints.chainStageApprovals(workspaceSlug, chainId))
      .then((res) => {
        const payload = res?.data as TResearchEnvelope<TResearchChainStageApprovalSummary> | undefined;
        if (!payload?.data) throw payload ?? {};
        return payload.data;
      })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async createChainStageMaterial(
    workspaceSlug: string,
    chainId: string,
    stageCode: string,
    payload: TResearchChainStageMaterialCreatePayload
  ) {
    return this.post(researchEndpoints.chainStageMaterials(workspaceSlug, chainId, stageCode), {
      ...payload,
      request_id: request_id(),
    })
      .then((res) => {
        const response = res?.data as TResearchEnvelope<TResearchChainStageMaterialItem> | undefined;
        if (!response?.data) throw response ?? {};
        return response.data;
      })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async deleteChainStageMaterial(
    workspaceSlug: string,
    chainId: string,
    stageCode: string,
    materialId: string
  ): Promise<void> {
    await this.delete(researchEndpoints.chainStageMaterial(workspaceSlug, chainId, stageCode, materialId)).catch(
      (err) => {
        throw err?.response?.data ?? err;
      }
    );
  }

  async runChainStagePrecheck(workspaceSlug: string, chainId: string, stageCode: string) {
    return this.post(researchEndpoints.chainStagePrecheck(workspaceSlug, chainId, stageCode), {
      request_id: request_id(),
    })
      .then((res) => {
        const payload = res?.data as TResearchEnvelope<TResearchChainStageApproval["latest_precheck"]> | undefined;
        if (!payload?.data) throw payload ?? {};
        return payload.data;
      })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async submitChainStage(
    workspaceSlug: string,
    chainId: string,
    stageCode: string,
    payload: { node_id: string; requires_pi?: boolean; escalation_reason?: string }
  ) {
    return this.post(researchEndpoints.chainStageSubmit(workspaceSlug, chainId, stageCode), {
      ...payload,
      request_id: request_id(),
    })
      .then((res) => {
        const response = res?.data as TResearchEnvelope<TResearchChainStageApproval> | undefined;
        if (!response?.data) throw response ?? {};
        return response.data;
      })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async reviewChainStage(
    workspaceSlug: string,
    chainId: string,
    stageCode: string,
    payload: { action: "APPROVE" | "RETURN"; comment?: string; escalate_to_pi?: boolean }
  ) {
    return this.post(researchEndpoints.chainStageReview(workspaceSlug, chainId, stageCode), {
      ...payload,
      request_id: request_id(),
    })
      .then((res) => {
        const response = res?.data as TResearchEnvelope<TResearchChainStageApproval> | undefined;
        if (!response?.data) throw response ?? {};
        notifyWorkspaceTodosUpdated();
        return response.data;
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

  async deleteChainNode(workspaceSlug: string, nodeId: string) {
    return this.delete(researchEndpoints.chainNode(workspaceSlug, nodeId)).catch((error) => {
      throw error?.response?.data ?? error;
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
        const payload = res?.data as
          | {
              items?: TResearchKnowledgeBase[];
              degraded?: boolean;
              degraded_reason?: string;
              state?: TResearchKnowledgeRequestState;
              request_id?: string;
              scope?: TResearchKnowledgeScope;
              org_unit_id?: string | null;
              org_unit_name?: string | null;
              connection_status?: "not_connected" | "connected" | "degraded";
              candidates?: TResearchKnowledgeCandidate[];
              upload_limits?: TResearchChainUploadLimits;
            }
          | undefined;
        return {
          items: payload?.items ?? [],
          degraded: Boolean(payload?.degraded),
          degraded_reason: payload?.degraded_reason ?? "",
          state: payload?.state ?? "READY",
          request_id: payload?.request_id ?? "",
          scope: payload?.scope ?? "LEGACY_CHAIN",
          orgUnitId: payload?.org_unit_id ?? "",
          orgUnitName: payload?.org_unit_name ?? "",
          connectionStatus: payload?.connection_status ?? "",
          candidates: payload?.candidates ?? [],
          uploadLimits: payload?.upload_limits ?? {
            pdf_max_mb: 500,
            markdown_max_mb: 500,
            office_max_mb: 500,
          },
        };
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
        const response = err?.response;
        if (response && (typeof response.data === "string" || response.data == null)) {
          throw {
            error_code: response.status === 413 ? "file_size_exceeded" : "upstream_error",
            message: "",
            status: response.status,
          };
        }
        throw { ...(response?.data ?? err), status: response?.status ?? 0 };
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
