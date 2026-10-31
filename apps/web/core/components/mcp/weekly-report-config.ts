import { API_BASE_URL } from "@plane/constants";
import type {
  WeeklyReportAction,
  WeeklyReportConnection,
  WeeklyReportIssued,
} from "@/services/weekly-report-mcp.service";
import type { MCPConfig } from "./connection-config";

export const weeklyReportActionLabels: Record<WeeklyReportAction, string> = {
  read_reports: "读取可见周报",
  save_draft: "保存草稿",
  submit: "正式提交",
  withdraw: "撤回提交",
  return: "退回报告",
  accept: "接受报告",
};

const invalid = () => new Error("连接配置无效，请核对已有连接后重新创建。");
/** 白名单提取元数据，避免配置密钥随列表长期驻留。 */
export function weeklyReportMetadata(value: WeeklyReportConnection): WeeklyReportConnection {
  return {
    id: value.id,
    workspace: value.workspace,
    label: value.label,
    actions: value.actions,
    report_type: value.report_type,
    period_policy: value.period_policy,
    created_at: value.created_at,
    expires_at: value.expires_at,
    revoked_at: value.revoked_at,
    last_used_at: value.last_used_at,
    configuration_available: value.configuration_available,
  };
}
export function weeklyReportConfig(value: WeeklyReportIssued, workspace: string): MCPConfig {
  try {
    const base = new URL(API_BASE_URL || window.location.origin);
    const endpoint = new URL(value.mcp_url || value.mcp_path, base);
    const relativeEndpoint = new URL(value.mcp_path, base);
    const token = value.headers["X-Weekly-Report-Token"];
    const name = value.server_key || value.label;
    if (
      value.workspace !== workspace ||
      !/^[a-f\d-]{36}$/i.test(value.id) ||
      !["http:", "https:"].includes(endpoint.protocol) ||
      endpoint.origin !== base.origin ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.pathname !== `/api/research/workspaces/${encodeURIComponent(workspace)}/weekly-report-agent/mcp/` ||
      relativeEndpoint.href !== endpoint.href ||
      (value.mcp_url && endpoint.origin !== base.origin) ||
      name !== value.label.trim() ||
      !/^pwr_[A-Za-z0-9_-]{43}$/.test(token)
    )
      throw invalid();
    return {
      name,
      url: endpoint.href,
      headers: { "X-Weekly-Report-Token": token },
    };
  } catch {
    throw invalid();
  }
}
