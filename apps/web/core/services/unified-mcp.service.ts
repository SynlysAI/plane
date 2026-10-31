import { API_BASE_URL } from "@plane/constants";
import { create } from "axios";

export type UnifiedDomain = "administrative" | "research";
export type UnifiedMode = "read" | "read_write";
export type UnifiedWorkspace = {
  id: string;
  slug: string;
  name: string;
  domains: Partial<Record<UnifiedDomain, UnifiedMode[]>>;
};
export type UnifiedScope = {
  include_future_objects: boolean;
  workspaces: {
    workspace_id: string;
    workspace_name?: string | null;
    domains: Partial<Record<UnifiedDomain, UnifiedMode>>;
  }[];
};
export type UnifiedConnection = {
  id: string;
  name: string;
  scope: UnifiedScope;
  implemented_capabilities: string[];
  created_at: string;
  expires_at: string | null;
  configuration_available: boolean;
  revoked_at: string | null;
  last_used_at: string | null;
};
export type UnifiedIssued = UnifiedConnection & {
  secret: string;
  server_key: string;
  mcp_url: string;
  codex_toml: string;
  sciencediscovery_json: string;
  api_docs_url: string;
};
export type UnifiedPage<T> = { results: T[]; next_cursor: string | null; csrf_token: string };
export type UnifiedOptions = UnifiedPage<UnifiedWorkspace> & {
  ttl_seconds: number;
  ttl_days: (number | null)[];
  default_ttl_days: number;
  max_workspaces: number;
  write_requires_future_objects: boolean;
};
export type UnifiedIssueInput = UnifiedScope & { name: string; ttl_days?: number | null };

function problem(error: unknown) {
  const response = (error as { response?: { status?: number; data?: { error_code?: string; message?: string } } })
    ?.response;
  return { status: response?.status, code: response?.data?.error_code, message: response?.data?.message };
}

/** Human session and CSRF only; no stored machine secret or global logout interceptor. */
export class UnifiedMCPService {
  private http = create({ baseURL: API_BASE_URL, withCredentials: true, timeout: 30_000 });
  /** 按需取回本人连接的完整配置。 */
  async configuration(id: string, csrf: string): Promise<UnifiedIssued> {
    return this.http
      .post(`/api/mcp/connections/${encodeURIComponent(id)}/configuration/`, {}, { headers: { "X-CSRFToken": csrf } })
      .then((r) => r.data)
      .catch((error) => {
        throw problem(error);
      });
  }
  /** 重置连接密钥，保留原授权和有效期。 */
  async rotate(id: string, csrf: string): Promise<UnifiedIssued> {
    return this.http
      .post(`/api/mcp/connections/${encodeURIComponent(id)}/rotate/`, {}, { headers: { "X-CSRFToken": csrf } })
      .then((r) => r.data)
      .catch((error) => {
        throw problem(error);
      });
  }
  async options(cursor?: string): Promise<UnifiedOptions> {
    return this.http
      .get("/api/mcp/connections/options/", { params: { cursor } })
      .then((response) => response.data)
      .catch((error) => {
        throw problem(error);
      });
  }
  async connections(cursor?: string): Promise<UnifiedPage<UnifiedConnection>> {
    return this.http
      .get("/api/mcp/connections/", { params: { cursor } })
      .then((response) => response.data)
      .catch((error) => {
        throw problem(error);
      });
  }
  async issue(data: UnifiedIssueInput, csrf: string): Promise<UnifiedIssued> {
    return this.http
      .post("/api/mcp/connections/", data, { headers: { "X-CSRFToken": csrf } })
      .then((response) => response.data)
      .catch((error) => {
        throw problem(error);
      });
  }
  async revoke(id: string, csrf: string): Promise<{ revoked: boolean }> {
    return this.http
      .post(`/api/mcp/connections/${encodeURIComponent(id)}/revoke/`, {}, { headers: { "X-CSRFToken": csrf } })
      .then((response) => response.data)
      .catch((error) => {
        throw problem(error);
      });
  }

  /** 软删除本人连接，保留审计与写回执。 */
  async delete(id: string, csrf: string): Promise<{ deleted: boolean; id: string }> {
    return this.http
      .delete(`/api/mcp/connections/${encodeURIComponent(id)}/`, { headers: { "X-CSRFToken": csrf } })
      .then((response) => response.data)
      .catch((error) => {
        throw problem(error);
      });
  }
}
