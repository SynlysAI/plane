/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { API_BASE_URL, researchEndpoints } from "@plane/constants";
import type { TAgentPluginManifest, TResearchAgentSession } from "@plane/types";
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

export type TAgentMessageResponse = {
  session: TResearchAgentSession;
  events: TAgentRunEvent[];
};

function request_id() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class ResearchAgentService extends APIService {
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

  async sendMessage(workspaceSlug: string, sessionId: string, content: string) {
    return this.post(researchEndpoints.agentMessages(workspaceSlug, sessionId), {
      request_id: request_id(),
      content,
    })
      .then((res) => res?.data as TAgentMessageResponse)
      .catch((err) => {
        const data = err?.response?.data as TAgentMessageResponse | undefined;
        if (data?.session) return data;
        throw err?.response?.data;
      });
  }

  async getEvents(workspaceSlug: string, runId: string, afterSeq = 0) {
    return this.get(researchEndpoints.agentRunEvents(workspaceSlug, runId), { params: { after_seq: afterSeq } })
      .then((res) => res?.data as { results: TAgentRunEvent[]; count: number; latest_seq: number })
      .catch((err) => {
        throw err?.response?.data;
      });
  }
}
