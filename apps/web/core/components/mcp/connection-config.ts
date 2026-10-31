/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import type { TNativeConnection, TResearchIssued } from "@/services/mcp.service";

export type MCPConfig = { name: string; url: string; headers: Record<string, string> };
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const invalidConfig = () => new Error("服务返回的连接配置格式无效，请联系管理员。");

export function nativeConfig(value: TNativeConnection): MCPConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.sciencediscovery_json);
  } catch {
    // JSON parser errors can contain source text and therefore credentials.
    throw invalidConfig();
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) throw invalidConfig();
  const servers = Object.values(parsed.mcpServers);
  if (servers.length !== 1 || !isRecord(servers[0])) throw invalidConfig();
  const config = servers[0];
  const url = value.mcp_url || config.url;
  if (typeof url !== "string" || !isRecord(config.headers)) throw invalidConfig();
  try {
    const endpoint = new URL(url);
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
      throw invalidConfig();
  } catch {
    throw invalidConfig();
  }
  const headers: Record<string, string> = {};
  const entries = Object.entries(config.headers);
  if (!entries.length) throw invalidConfig();
  for (const [key, header] of entries) {
    if (!key || typeof header !== "string" || !header.trim()) throw invalidConfig();
    Object.defineProperty(headers, key, { value: header, enumerable: true });
  }
  return { name: `plane_admin_${value.id}`, url, headers };
}

export function parseNativeDays(value: string, maximum: number | undefined): number | null {
  if (!value.trim() || !maximum) return null;
  const days = Number(value);
  return Number.isInteger(days) && days >= 1 && days <= maximum ? days : null;
}

export function researchConfig(value: TResearchIssued): MCPConfig {
  return {
    name: `plane_research_${value.id.replaceAll("-", "")}`,
    url: new URL(value.mcp_path, API_BASE_URL || window.location.origin).href,
    headers: value.headers,
  };
}
export function configurationFiles(configs: MCPConfig[]) {
  return {
    json: JSON.stringify(
      {
        mcpServers: Object.fromEntries(
          configs.map((c) => [c.name, { type: "http", url: c.url, headers: c.headers, timeoutSeconds: 120 }])
        ),
      },
      null,
      2
    ),
    toml: configs
      .map(
        (c) =>
          `[mcp_servers.${JSON.stringify(c.name)}]\nurl = ${JSON.stringify(c.url)}\nhttp_headers = { ${Object.entries(
            c.headers
          )
            .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
            .join(", ")} }\ntool_timeout_sec = 120\ndefault_tools_approval_mode = "prompt"\n`
      )
      .join("\n"),
  };
}
export const actionLabels: Record<string, string> = {
  append_task_comment: "追加任务评论",
  create_task: "创建任务",
  attach_task_resource: "关联任务资源",
  save_analysis_draft: "保存分析草稿",
  append_research_note: "追加科研笔记",
};
export function failureMessage(failure: unknown) {
  const error = failure as { status?: number; message?: string };
  if (error?.status === 401) return "登录或授权已失效，请重新验证身份。";
  return error?.message || "操作失败，请重试。";
}
