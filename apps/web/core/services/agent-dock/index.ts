/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";

export type TAgentDockProvider = "SYNLORA" | "SCIENCE_DISCOVERY";

export type TAgentContextEnvelope = {
  schema_version: "agent-context-envelope.v2";
  provider?: TAgentDockProvider;
  science_discovery?: { available: boolean; reason: string };
  context_id: string;
  context_version: number;
  status: "unlinked" | "loading" | "linked" | "refreshed" | "expired" | "failed" | "forbidden";
  target_type: "WORKSPACE" | "PROJECT" | "RESEARCH_CHAIN" | "RESEARCH_CHAIN_NODE";
  target_hierarchy: Array<{ type: string; id: string; title: string }>;
  resources_summary: { total: number; by_kind: Record<string, number> };
  manifest_summary?: {
    summary: string;
    resources: Array<{
      kind: string;
      id: string;
      title: string;
      status: string;
      updated_at: string;
      version?: number;
    }>;
  };
  manifest_hash: string;
  page_context?: {
    schema_version: string;
    route: string;
    page_kind: string;
    depth: string;
    generated_at: string;
    focus: { type: string; id: string; title: string; status?: string };
    summary: string;
    hash: string;
    resources: Array<Record<string, unknown>>;
    suggested_tools: Array<Record<string, unknown>>;
  };
  capabilities: {
    agent: string;
    tool_source?: string;
    allowed_tools: string[];
    allowed_plugins: string[];
    allowed_mcp_ids: string[];
    allowed_knowledge_base_ids: string[];
    allowed_file_ids: string[];
  };
  expiry: string;
  session_binding: { workspace_id: string; target_key: string; user_id: string };
};

export type TAgentDockSession = {
  schema_version: "agent-dock-session.v1";
  session_id: string;
  run_id: string;
  target_type: TAgentContextEnvelope["target_type"];
  target_key: string;
  context: { context_id: string; context_version: number; status: string; expires_at: string };
  status: string;
  last_error: string;
  provider: TAgentDockProvider;
  assembly: Record<string, unknown>;
  latest_seq: number;
  source_cursor?: number;
  run_start_cursor?: number;
  updated_at?: string;
  created_at?: string;
  target_title?: string | null;
  target_metadata?: {
    workspace: { id: string; slug: string; name: string };
    target: { type: string; id: string; title: string; hierarchy: Array<{ type: string; id: string; title: string }> };
    page?: {
      route: string;
      page_kind: string;
      focus_id: string;
      focus_title: string;
      hash: string;
      generated_at: string;
    };
  };
};

export type TAgentDockEvent = {
  schema_version: string;
  run_id: string;
  seq: number;
  source_seq?: number;
  event_type: string;
  raw_event_type?: string;
  normalized_event_type?: string;
  payload: Record<string, unknown>;
  request_id: string;
  created_at: string;
};

export type TAgentFocusRef = {
  type: "RESEARCH_TASK" | "RESEARCH_NODE" | "RESEARCH_CHAIN" | "ISSUE";
  id: string;
};

function requestId(prefix: string) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class AgentDockService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  /** Resolve current route context on the server; the browser never supplies privileges. */
  async resolveContext(
    workspaceSlug: string,
    route: string,
    selectedText = "",
    focusRef?: TAgentFocusRef,
    provider: TAgentDockProvider = "SYNLORA"
  ) {
    return this.post(`/api/workspaces/${workspaceSlug}/agent-dock/context/resolve/`, {
      request_id: requestId("context"),
      route,
      provider,
      selected_text: selectedText.slice(0, 4000),
      ...(focusRef ? { focus_ref: focusRef } : {}),
    })
      .then((response) => response?.data as TAgentContextEnvelope)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async listSessions(
    workspaceSlug: string,
    options: { sessionIds?: string[]; target_type?: string; route?: string } = {}
  ) {
    return this.get(`/api/workspaces/${workspaceSlug}/agent-dock/sessions/`, {
      params: {
        ...(options.sessionIds?.length ? { session_ids: options.sessionIds.join(",") } : {}),
        ...(options.target_type ? { target_type: options.target_type } : {}),
        ...(options.route ? { route: options.route } : {}),
      },
    })
      .then((response) => response?.data as { results: TAgentDockSession[]; count: number })
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async getSession(workspaceSlug: string, sessionId: string) {
    return this.get(`/api/workspaces/${workspaceSlug}/agent-dock/sessions/${sessionId}/`)
      .then((response) => response?.data as TAgentDockSession)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async refreshSessionContext(workspaceSlug: string, sessionId: string, contextId: string) {
    return this.post(`/api/workspaces/${workspaceSlug}/agent-dock/sessions/${sessionId}/context/refresh/`, {
      context_id: contextId,
    })
      .then((response) => response?.data as TAgentDockSession)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async getContext(workspaceSlug: string, contextId: string) {
    return this.get(`/api/workspaces/${workspaceSlug}/agent-dock/context/${contextId}/`)
      .then((response) => response?.data as TAgentContextEnvelope)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async createSession(workspaceSlug: string, contextId: string, provider: TAgentDockProvider = "SYNLORA") {
    return this.post(`/api/workspaces/${workspaceSlug}/agent-dock/sessions/`, {
      request_id: requestId("session"),
      context_id: contextId,
      provider,
    })
      .then((response) => response?.data as TAgentDockSession)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async sendMessage(
    workspaceSlug: string,
    sessionId: string,
    content: string,
    options: { route?: string; focusRef?: TAgentFocusRef; selectedText?: string; provider?: TAgentDockProvider } = {}
  ) {
    return this.post(`/api/workspaces/${workspaceSlug}/agent-dock/sessions/${sessionId}/messages/`, {
      request_id: requestId("message"),
      content,
      provider: options.provider ?? "SYNLORA",
      route: options.route ?? "",
      ...(options.focusRef ? { focus_ref: options.focusRef } : {}),
      selected_text: options.selectedText?.slice(0, 4000) ?? "",
    })
      .then((response) => response?.data as TAgentDockSession)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /** Open the authenticated Plane BFF event stream for one run. */
  async streamEvents(workspaceSlug: string, runId: string, afterSeq: number, signal: AbortSignal): Promise<Response> {
    const url = new URL(
      `${API_BASE_URL}/api/workspaces/${workspaceSlug}/agent-dock/runs/${runId}/events/stream/`,
      window.location.origin
    );
    url.searchParams.set("after_seq", String(afterSeq));
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "text/event-stream",
        ...(afterSeq >= 0 ? { "Last-Event-ID": String(afterSeq) } : {}),
      },
      signal,
    });
    if (!response.ok) {
      let detail: unknown = response.statusText;
      try {
        detail = await response.json();
      } catch {
        // Keep the HTTP status text when the BFF returns a non-JSON error.
      }
      throw Object.assign(new Error("Agent Dock event stream failed"), { status: response.status, detail });
    }
    return response;
  }

  async getEvents(workspaceSlug: string, runId: string, afterSeq = 0) {
    return this.get(`/api/workspaces/${workspaceSlug}/agent-dock/runs/${runId}/events/`, {
      params: { after_seq: afterSeq },
    })
      .then(
        (response) =>
          response?.data as {
            results: TAgentDockEvent[];
            count: number;
            latest_seq: number;
            session: TAgentDockSession;
          }
      )
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  /** 分页读取会话所有轮次的持久事件，游标由服务端签名和绑定。 */
  async getSessionEvents(workspaceSlug: string, sessionId: string, cursor?: string) {
    return this.get(`/api/workspaces/${workspaceSlug}/agent-dock/sessions/${sessionId}/events/`, {
      params: { limit: 200, ...(cursor ? { cursor } : {}) },
    })
      .then(
        (response) =>
          response?.data as {
            results: TAgentDockEvent[];
            count: number;
            next_cursor: string | null;
            has_more: boolean;
            session: TAgentDockSession;
          }
      )
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async cancelRun(workspaceSlug: string, runId: string) {
    return this.post(`/api/workspaces/${workspaceSlug}/agent-dock/runs/${runId}/cancel/`)
      .then((response) => response?.data as TAgentDockSession)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async answerRun(workspaceSlug: string, runId: string, approved: boolean, permissionRequestId?: string) {
    return this.post(`/api/workspaces/${workspaceSlug}/agent-dock/runs/${runId}/answer/`, {
      approved,
      ...(permissionRequestId ? { permission_request_id: permissionRequestId } : {}),
    })
      .then((response) => response?.data as TAgentDockSession)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }
}
