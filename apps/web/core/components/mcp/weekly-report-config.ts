import { API_BASE_URL } from "@plane/constants";
import type { WeeklyReportAction, WeeklyReportIssued } from "@/services/weekly-report-mcp.service";
import type { MCPConfig } from "./connection-config";

export const weeklyReportActionLabels: Record<WeeklyReportAction, string> = {
  save_draft: "保存草稿",
  submit: "正式提交",
};

const invalid = () => new Error("连接配置无效，请核对已有连接后重新创建。");
export function weeklyReportConfig(value: WeeklyReportIssued, workspace: string): MCPConfig {
  try {
    const base = new URL(API_BASE_URL || window.location.origin);
    const endpoint = new URL(value.mcp_path, base);
    const token = value.headers["X-Weekly-Report-Token"];
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
      !/^pwr_[A-Za-z0-9_-]{43}$/.test(token)
    )
      throw invalid();
    return {
      name: `plane_weekly_report_${value.id.replaceAll("-", "")}`,
      url: endpoint.href,
      headers: { "X-Weekly-Report-Token": token },
    };
  } catch {
    throw invalid();
  }
}
