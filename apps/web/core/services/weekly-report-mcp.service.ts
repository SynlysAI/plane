import { API_BASE_URL } from "@plane/constants";
import { create } from "axios";

export type WeeklyReportAction = "save_draft" | "submit";
export type WeeklyReportWorkspace = {
  id: string;
  slug: string;
  name: string;
  enabled: boolean;
  unavailable_reason: string | null;
  actions: WeeklyReportAction[];
  ttl_days: number[];
  period_policy: string;
  period_description: string;
};
export type WeeklyReportOptions = {
  workspaces: WeeklyReportWorkspace[];
  identity: { user_id: string; display_name: string };
  csrf_token: string;
  contract_version: string;
};
export type WeeklyReportConnection = {
  id: string;
  workspace: string;
  label: string;
  actions: WeeklyReportAction[];
  report_type: "WEEKLY";
  period_policy: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
};
export type WeeklyReportIssued = WeeklyReportConnection & {
  mcp_path: string;
  headers: Record<string, string>;
  csrf_token: string;
};
export type WeeklyReportConnections = {
  results: WeeklyReportConnection[];
  next_cursor: string | null;
  csrf_token: string;
};
export type WeeklyReportIssueRequest = { label: string; actions: WeeklyReportAction[]; ttl_days: number };
export type WeeklyReportProblem = { status?: number; uncertain: boolean; message: string };

// Never surface raw server/transport errors: issuance responses can contain a secret.
function problem(error: unknown): WeeklyReportProblem {
  const response = (error as { response?: { status?: number; data?: { error_code?: string } } })?.response;
  const status = response?.status;
  const messages: Record<string, string> = {
    grant_limit: "有效连接已达上限，请先撤销不再使用的连接。",
    invalid_arguments: "连接信息无效，请核对名称、权限和有效期。",
    invalid_cursor: "分页已失效，请刷新连接列表。",
    feature_disabled: "周报连接尚未开放。",
    report_org_required: "请先完善本人组织归属。",
  };
  return {
    status,
    uncertain: status === undefined || status >= 500,
    message:
      status === 401
        ? "登录已失效，请重新登录。"
        : status === 403
          ? "当前身份或会话无权执行此操作，请刷新后重试。"
          : messages[response?.data?.error_code ?? ""] || "服务请求失败，请刷新后重试。",
  };
}

/** Human session only; no machine credentials, retries or global logout interceptor. */
export class WeeklyReportMCPService {
  private http = create({ baseURL: API_BASE_URL, withCredentials: true, timeout: 30_000 });
  private path(workspace: string) {
    return `/api/research/workspaces/${encodeURIComponent(workspace)}/mcp/weekly-report/`;
  }
  async options(): Promise<WeeklyReportOptions> {
    return this.http
      .get("/api/research/mcp/weekly-report/options/")
      .then((r) => r.data)
      .catch((e) => {
        throw problem(e);
      });
  }
  async connections(workspace: string, cursor?: string): Promise<WeeklyReportConnections> {
    return this.http
      .get(this.path(workspace) + "connections/", { params: { cursor } })
      .then((r) => r.data)
      .catch((e) => {
        throw problem(e);
      });
  }
  async issue(workspace: string, data: WeeklyReportIssueRequest, csrf: string): Promise<WeeklyReportIssued> {
    return this.http
      .post(this.path(workspace) + "connections/", data, { headers: { "X-CSRFToken": csrf } })
      .then((r) => r.data)
      .catch((e) => {
        throw problem(e);
      });
  }
  async revoke(workspace: string, id: string, csrf: string): Promise<{ revoked: boolean; id: string }> {
    return this.http
      .post(
        this.path(workspace) + `connections/${encodeURIComponent(id)}/revoke/`,
        {},
        { headers: { "X-CSRFToken": csrf } }
      )
      .then((r) => r.data)
      .catch((e) => {
        throw problem(e);
      });
  }
}
