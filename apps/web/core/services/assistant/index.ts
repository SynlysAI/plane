/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

/**
 * AI assistant service: axios for control calls, native fetch for the SSE run
 * stream (axios cannot stream response bodies incrementally).
 */

import { API_BASE_URL } from "@plane/constants";
// services
import { APIService } from "@/services/api.service";

export type TAssistantStatus = {
  enabled: boolean;
  ready: boolean;
  credential_mode?: "SHARED" | "PERSONAL";
};

export type TAssistantSession = {
  thread_id: string;
  title: string;
};

export type TAssistantChatResponse = {
  request_id: string;
  run_id: string;
  status: string;
  message_id: number | null;
  thread_id: string;
  queued: boolean;
};

export type TAssistantRunResult = {
  status: string;
  output?: string;
  error?: string;
};

export type TAssistantHistoryMessage = {
  id?: string;
  role?: string;
  content?: string;
  type?: string;
  message_type?: string;
  created_at?: string;
};

export class AssistantService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  async getStatus(workspaceSlug: string): Promise<TAssistantStatus> {
    const response = await this.get(`/api/workspaces/${workspaceSlug}/assistant/status/`);
    return response.data;
  }

  async createSession(workspaceSlug: string, title?: string): Promise<TAssistantSession> {
    const response = await this.post(`/api/workspaces/${workspaceSlug}/assistant/session/`, {
      title,
    });
    return response.data;
  }

  async startChat(
    workspaceSlug: string,
    payload: { query: string; thread_id: string; request_id?: string }
  ): Promise<TAssistantChatResponse> {
    const response = await this.post(`/api/workspaces/${workspaceSlug}/assistant/chat/`, payload);
    return response.data;
  }

  async cancelRun(workspaceSlug: string, runId: string): Promise<void> {
    await this.post(`/api/workspaces/${workspaceSlug}/assistant/runs/${runId}/cancel/`);
  }

  async getRunResult(workspaceSlug: string, runId: string): Promise<TAssistantRunResult> {
    const response = await this.get(`/api/workspaces/${workspaceSlug}/assistant/runs/${runId}/result/`);
    return response.data;
  }

  async getHistory(workspaceSlug: string, threadId: string): Promise<TAssistantHistoryMessage[]> {
    const response = await this.get(
      `/api/workspaces/${workspaceSlug}/assistant/history/?thread_id=${encodeURIComponent(threadId)}`
    );
    const data = response.data;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.messages)) return data.messages;
    if (Array.isArray(data?.items)) return data.items;
    return [];
  }

  /**
   * Consume the SSE run-events stream. Calls `onChunk` with decoded text
   * chunks; resolves when the stream closes, rejects on network failure.
   * The AbortController signal is owned by the caller.
   */
  async streamRunEvents(
    workspaceSlug: string,
    runId: string,
    options: { lastEventId?: string | null; signal?: AbortSignal; onChunk: (chunk: string) => void }
  ): Promise<void> {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (options.lastEventId) headers["Last-Event-ID"] = options.lastEventId;
    const response = await fetch(`${API_BASE_URL}/api/workspaces/${workspaceSlug}/assistant/runs/${runId}/events/`, {
      method: "GET",
      credentials: "include",
      headers,
      signal: options.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`assistant_stream_http_${response.status}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // Sequential reads are the point of a stream; parallelising is meaningless.
    const pump = async (): Promise<void> => {
      const { done, value } = await reader.read();
      if (done) return;
      const text = decoder.decode(value, { stream: true });
      if (text) options.onChunk(text);
      await pump();
    };
    await pump();
    const tail = decoder.decode();
    if (tail) options.onChunk(tail);
  }
}
