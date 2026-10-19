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
};
export type TNativeConnection = TNativeToken & { codex_toml: string; sciencediscovery_json: string; mcp_url: string };

/** Human management only; the machine Bearer never enters research services. */
export class NativeMCPService {
  // A native portal 401 means verify the PAT, not log out of Plane.
  private http = create({ baseURL: API_BASE_URL, withCredentials: true });
  async read<T>(action: "options" | "session" | "tokens"): Promise<T> {
    return this.http
      .get(`/api/mcp/native/${action}/`)
      .then((response) => response.data)
      .catch((error) => {
        throw { status: error?.response?.status, message: error?.response?.data?.error || "读取行政接入服务失败。" };
      });
  }
  async write<T>(action: string, data: Record<string, unknown>, csrf: string, nativeCsrf: string): Promise<T> {
    return this.http
      .post(`/api/mcp/native/${action}/`, data, { headers: { "X-CSRFToken": csrf, "X-MCP-CSRF": nativeCsrf } })
      .then((response) => response.data)
      .catch((error) => {
        throw {
          status: error?.response?.status,
          message: error?.response?.data?.error || "行政连接操作失败，请核对后重试。",
        };
      });
  }
}
