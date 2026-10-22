/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import { create } from "axios";

export type TNativeOptions = {
  workspaces: string[];
  allow_publish: boolean;
  max_token_days: number;
  portal_url: string;
  plane_ui_url?: string;
  csrf_token: string;
};
export type TNativeSession = { name: string; csrf: string; expires: number };
export type TNativeToken = {
  id: string;
  workspace: string;
  label: string;
  publish: boolean;
  expires: number;
  revoked?: boolean;
  created?: number;
  last_used?: number | null;
};
export type TNativeConnection = TNativeToken & { codex_toml: string; sciencediscovery_json: string; mcp_url: string };
export type TNativeCandidates = {
  workspaces: string[];
  failures: { workspace: string; error: string }[];
  account: { id: string; name: string };
  identity_mapping: "independent";
};
export type TMCPPage<T> = { results: T[]; next_cursor: string | null; csrf_token: string; ttl_seconds?: number };
export type TMCPChain = { id: string; title: string; status: string };
export type TMCPNode = {
  id: string;
  chain_id: string;
  title: string;
  status: string;
  actions: string[];
  write_unavailable_reason: string;
};
export type TResearchConnection = {
  id: string;
  label: string;
  workspace: string;
  chain_id: string;
  chain_title: string;
  node_id: string;
  node_title: string;
  mode: "read" | "write";
  actions: string[];
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
};
export type TResearchIssued = TResearchConnection & { mcp_path: string; headers: Record<string, string> };

const problem = (error: {
  response?: { status?: number; data?: { message?: string; error?: string; detail?: string } };
}) => ({
  status: error?.response?.status,
  message:
    error?.response?.data?.message ||
    error?.response?.data?.error ||
    error?.response?.data?.detail ||
    "服务请求失败，请重试。",
});
/** Session management clients deliberately avoid machine credentials and global logout interceptors. */
export class NativeMCPService {
  private http = create({ baseURL: API_BASE_URL, withCredentials: true });
  async read<T>(action: "options" | "session" | "tokens" | "candidates"): Promise<T> {
    return this.http
      .get(`/api/mcp/native/${action}/`)
      .then((r) => r.data)
      .catch((error) => {
        throw problem(error);
      });
  }
  async write<T>(action: string, data: Record<string, unknown>, csrf: string, nativeCsrf: string): Promise<T> {
    return this.http
      .post(`/api/mcp/native/${action}/`, data, { headers: { "X-CSRFToken": csrf, "X-MCP-CSRF": nativeCsrf } })
      .then((r) => r.data)
      .catch((error) => {
        throw problem(error);
      });
  }
}
export class ResearchMCPService {
  private http = create({ baseURL: API_BASE_URL, withCredentials: true });
  private path(workspace: string) {
    return `/api/research/workspaces/${encodeURIComponent(workspace)}/mcp/`;
  }
  async candidates(
    workspace: string,
    params: { q?: string; chain_id?: string; cursor?: string } = {}
  ): Promise<TMCPPage<TMCPChain | TMCPNode>> {
    return this.http
      .get(this.path(workspace) + "candidates/", { params })
      .then((r) => r.data)
      .catch((error) => {
        throw problem(error);
      });
  }
  async connections(workspace: string, cursor?: string): Promise<TMCPPage<TResearchConnection>> {
    return this.http
      .get(this.path(workspace) + "connections/", { params: { cursor } })
      .then((r) => r.data)
      .catch((error) => {
        throw problem(error);
      });
  }
  async issue(
    workspace: string,
    data: { node_id: string; label: string; mode: "read" | "write"; actions: string[] },
    csrf: string
  ): Promise<TResearchIssued> {
    return this.http
      .post(this.path(workspace) + "connections/", data, { headers: { "X-CSRFToken": csrf } })
      .then((r) => r.data)
      .catch((error) => {
        throw problem(error);
      });
  }
  async revoke(workspace: string, id: string, csrf: string): Promise<{ revoked: boolean }> {
    return this.http
      .post(
        this.path(workspace) + `connections/${encodeURIComponent(id)}/revoke/`,
        {},
        { headers: { "X-CSRFToken": csrf } }
      )
      .then((r) => r.data)
      .catch((error) => {
        throw problem(error);
      });
  }
}
