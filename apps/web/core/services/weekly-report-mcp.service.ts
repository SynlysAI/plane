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
  ttl_days: (number | null)[];
  default_ttl_days?: number;
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
  expires_at: string | null;
  configuration_available: boolean;
  revoked_at: string | null;
  last_used_at: string | null;
};
export type WeeklyReportIssued = WeeklyReportConnection & {
  server_key: string;
  mcp_path: string;
  mcp_url: string;
  headers: Record<string, string>;
  codex_toml: string;
  sciencediscovery_json: string;
  api_docs_url: string;
  csrf_token: string;
};
export type WeeklyReportConnections = {
  results: WeeklyReportConnection[];
  next_cursor: string | null;
  csrf_token: string;
};
export type WeeklyReportIssueRequest = { label: string; actions: WeeklyReportAction[]; ttl_days: number | null };
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
    reports_disabled: "当前账号或工作区尚未开放周报连接。",
    policy_changed: "工作区周报设置已变化，请刷新后重试。",
    connection_inactive: "连接已过期或撤销，请创建新连接。",
    configuration_unavailable: "此连接尚不支持配置回看，请确认后重置密钥。",
    credential_unavailable: "配置无法恢复，请重试或确认后重置密钥。",
    report_org_required: "请先完善本人组织归属。",
  };
  return {
    status,
    uncertain: status === undefined || status >= 500,
    message:
      status === 401
        ? "登录已失效，请重新登录。"
        : messages[response?.data?.error_code ?? ""]
          ? messages[response?.data?.error_code ?? ""]
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
  /** 按需取回周报客户端配置。 */
  async configuration(workspace: string, id: string, csrf: string): Promise<WeeklyReportIssued> {
    return this.http
      .post(
        this.path(workspace) + `connections/${encodeURIComponent(id)}/configuration/`,
        {},
        { headers: { "X-CSRFToken": csrf } }
      )
      .then((r) => r.data)
      .catch((e) => {
        throw problem(e);
      });
  }
  /** 重置周报连接密钥。 */
  async rotate(workspace: string, id: string, csrf: string): Promise<WeeklyReportIssued> {
    return this.http
      .post(
        this.path(workspace) + `connections/${encodeURIComponent(id)}/rotate/`,
        {},
        { headers: { "X-CSRFToken": csrf } }
      )
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

  /** 软删除本人周报连接，保留提案与审计。 */
  async delete(workspace: string, id: string, csrf: string): Promise<{ deleted: boolean; id: string }> {
    return this.http
      .delete(this.path(workspace) + `connections/${encodeURIComponent(id)}/`, {
        headers: { "X-CSRFToken": csrf },
      })
      .then((r) => r.data)
      .catch((e) => {
        throw problem(e);
      });
  }
}
