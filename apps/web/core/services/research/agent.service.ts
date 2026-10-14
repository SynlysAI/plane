/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { API_BASE_URL, researchEndpoints } from "@plane/constants";
import type { TAgentPluginManifest, TResearchAgentApproval, TResearchAgentSession } from "@plane/types";
import { APIService } from "@/services/api.service";

export type TAgentRunEvent = {
  schema_version: "agent-plugin.v1";
  run_id: string;
  seq: number;
  event_type: string;
  payload: Record<string, unknown>;
  request_id: string;
  created_at: string;
};

type TAgentMessageResponse = {
  session: TResearchAgentSession;
  events: TAgentRunEvent[];
};

export type TAgentApprovalDecision = "APPROVED" | "APPROVED_ALWAYS" | "REJECTED";

function request_id() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class ResearchAgentService extends APIService {
  /** 获取当前课题可见的正式报告选择项。 */
  async getFormalReports(workspaceSlug: string, chainNodeId: string) {
    return this.get(`/api/research/workspaces/${workspaceSlug}/formal-reports/`, {
      params: { chain_node_id: chainNodeId },
    }).then(
      (response) =>
        response.data as {
          results: { report_id: string; version_no: number; title: string; characters: number }[];
          association_hint: string;
        }
    );
  }
  constructor() {
    super(API_BASE_URL);
  }

  async getManifest(workspaceSlug: string) {
    return this.get(researchEndpoints.agentManifest(workspaceSlug))
      .then((res) => res?.data as TAgentPluginManifest)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async createSession(workspaceSlug: string, chainNodeId: string) {
    return this.post(researchEndpoints.agentSessions(workspaceSlug), {
      request_id: request_id(),
      chain_node_id: chainNodeId,
    })
      .then((res) => res?.data as TResearchAgentSession)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async closeSession(workspaceSlug: string, sessionId: string) {
    return this.post(researchEndpoints.agentSessionClose(workspaceSlug, sessionId), {})
      .then((res) => res?.data as TResearchAgentSession)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async cancelRun(workspaceSlug: string, runId: string) {
    return this.post(researchEndpoints.agentRunCancel(workspaceSlug, runId), {})
      .then((res) => res?.data as TResearchAgentSession)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async sendMessage(
    workspaceSlug: string,
    sessionId: string,
    content: string,
    reports?: { report_id: string; version_no: number }[]
  ) {
    return this.post(researchEndpoints.agentMessages(workspaceSlug, sessionId), {
      request_id: request_id(),
      content,
      ...(reports ? { reports } : {}),
    })
      .then((res) => res?.data as TAgentMessageResponse)
      .catch((err) => {
        const data = err?.response?.data as TAgentMessageResponse | undefined;
        if (data?.session) return data;
        throw err?.response?.data;
      });
  }

  /** 上传一个分析文件到 ScienceDiscovery 会话工作区。 */
  async uploadSessionFile(workspaceSlug: string, sessionId: string, file: File) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("request_id", request_id());
    return this.post(researchEndpoints.agentSessionFiles(workspaceSlug, sessionId), formData)
      .then(
        (res) =>
          res?.data as {
            upload?: { file_name: string; file_hash: string; sd_path: string };
            event?: TAgentRunEvent;
            idempotent?: boolean;
          }
      )
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async getEvents(workspaceSlug: string, runId: string, afterSeq = 0) {
    return this.get(researchEndpoints.agentRunEvents(workspaceSlug, runId), { params: { after_seq: afterSeq } })
      .then(
        (res) =>
          res?.data as {
            results: TAgentRunEvent[];
            count: number;
            latest_seq: number;
            session?: TResearchAgentSession;
          }
      )
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async getApprovals(workspaceSlug: string) {
    return this.get(researchEndpoints.agentApprovals(workspaceSlug))
      .then((res) => res?.data as { results: TResearchAgentApproval[]; count: number })
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  /** 下载一个 ScienceDiscovery 产物版本的内容字节流。 */
  async downloadArtifactContent(workspaceSlug: string, sessionId: string, versionId: string) {
    return this.get(researchEndpoints.agentSessionArtifactContent(workspaceSlug, sessionId, versionId), {
      responseType: "blob",
    })
      .then((res) => res?.data as Blob)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  async decideApproval(
    workspaceSlug: string,
    runId: string,
    payload: {
      request_id: string;
      decision: TAgentApprovalDecision;
      tool_call_id: string;
      reason?: string;
    }
  ) {
    return this.post(researchEndpoints.agentApproval(workspaceSlug, runId), payload)
      .then((res) => res?.data as { session: TResearchAgentSession; event: TAgentRunEvent })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  async saveArtifact(
    workspaceSlug: string,
    sessionId: string,
    payload: {
      artifact_type: string;
      summary: string;
      confirmed: boolean;
      source_versions?: Array<Record<string, unknown>>;
      method?: string;
      metrics?: Record<string, unknown>;
      conclusion?: string;
      input_refs?: Array<Record<string, unknown>>;
      content_hash?: string;
    }
  ) {
    return this.post(researchEndpoints.agentArtifacts(workspaceSlug), {
      ...payload,
      session_id: sessionId,
      request_id: request_id(),
    })
      .then((res) => res?.data)
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  /** 读取当前用户的 ScienceDiscovery 后端连接与治理开关状态。 */
  async getBackendConnection(workspaceSlug: string) {
    return this.get(researchEndpoints.agentBackendConnections(workspaceSlug))
      .then(
        (res) =>
          res?.data as {
            connection: {
              id: string;
              base_url: string;
              is_enabled: boolean;
              has_credential: boolean;
              health_status: string;
              last_health_at?: string;
              last_error: string;
            } | null;
            governance_enabled: boolean;
          }
      )
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  /** 保存（新增或更新）当前用户的 ScienceDiscovery 连接。 */
  async saveBackendConnection(
    workspaceSlug: string,
    payload: { base_url: string; token?: string; is_enabled: boolean }
  ) {
    return this.post(researchEndpoints.agentBackendConnections(workspaceSlug), payload)
      .then((res) => res?.data as { id: string; base_url: string; is_enabled: boolean })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  /** 测试已保存的 ScienceDiscovery 连接。 */
  async testBackendConnection(workspaceSlug: string) {
    return this.post(researchEndpoints.agentBackendConnectionTest(workspaceSlug), {})
      .then((res) => res?.data as { ok: boolean; models?: number; error?: string })
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }

  /** 删除当前用户的 ScienceDiscovery 连接。 */
  async deleteBackendConnection(workspaceSlug: string) {
    return this.delete(researchEndpoints.agentBackendConnections(workspaceSlug))
      .then(() => true)
      .catch((err) => {
        throw err?.response?.data ?? err;
      });
  }
}
