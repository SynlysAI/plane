import type { UnifiedConnection, UnifiedIssued } from "@/services/unified-mcp.service";
import { configurationFiles } from "./connection-config";

/** Whitelist metadata so the connection list never retains an issuance secret. */
export function unifiedMetadata(value: UnifiedConnection): UnifiedConnection {
  return {
    id: value.id,
    name: value.name,
    scope: value.scope,
    implemented_capabilities: value.implemented_capabilities,
    created_at: value.created_at,
    expires_at: value.expires_at,
    configuration_available: value.configuration_available,
    revoked_at: value.revoked_at,
    last_used_at: value.last_used_at,
  };
}

export function unifiedConfiguration(value: UnifiedIssued) {
  try {
    const servers = Object.values(JSON.parse(value.sciencediscovery_json).mcpServers ?? {}) as {
      type?: string;
      url?: string;
      headers?: Record<string, string>;
    }[];
    const server = servers[0];
    const url = new URL(value.mcp_url);
    if (
      servers.length !== 1 ||
      server?.type !== "http" ||
      !server.url ||
      new URL(server.url).href !== url.href ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/api/mcp/" ||
      !/^pum_[A-Za-z0-9_-]{43}$/.test(value.secret) ||
      Object.keys(server.headers ?? {}).join() !== "Authorization" ||
      server.headers?.Authorization !== `Bearer ${value.secret}`
    )
      throw new Error();
    return configurationFiles([{ name: "plane", url: url.href, headers: { Authorization: `Bearer ${value.secret}` } }]);
  } catch {
    // Parser diagnostics can include credential text. Never expose them.
    throw new Error("客户端配置格式无法识别，请重新查看或联系管理员。");
  }
}

export function unifiedError(error: unknown) {
  const value = error as { status?: number; code?: string };
  if (value?.status === 401) return "登录已失效，请重新登录后刷新页面。";
  if (value?.code === "invalid_arguments") return "连接信息无效，请核对名称、权限和有效期。";
  if (value?.code === "invalid_cursor") return "分页已失效，请刷新连接列表。";
  if (value?.code === "configuration_unavailable") return "此连接尚不支持配置回看，请确认后重置密钥。";
  if (value?.code === "credential_unavailable") return "配置无法恢复，请重试或确认后重置密钥。";
  if (value?.code === "connection_inactive") return "连接已过期或撤销，请创建新连接。";
  if (value?.code === "grant_limit") return "有效连接已达到上限，请先撤销不再使用的连接。";
  if (value?.code === "disabled") return "科研读写当前未开放，请刷新可选范围或改用只读。";
  if (value?.code === "scope_denied" || value?.status === 403) return "当前权限或会话校验已变化，请刷新后重新选择。";
  if (value?.code === "capability_unavailable") return "当前范围不支持所选访问权限，请自动包含新增内容或改用只读。";
  return "请求未完成，请稍后重试。";
}
