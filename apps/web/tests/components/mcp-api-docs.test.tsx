// @vitest-environment jsdom
import React, { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ project: vi.fn(), weekly: vi.fn() }));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("@/services/unified-mcp.service", () => ({
  UnifiedMCPService: class {
    tools = mocks.project;
  },
}));
vi.mock("@/services/weekly-report-mcp.service", () => ({
  WeeklyReportMCPService: class {
    tools = mocks.weekly;
  },
}));
import { MCPApiDocs } from "@/components/mcp/mcp-api-docs";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const container = document.createElement("div");
document.body.appendChild(container);
let root = createRoot(container);

const tool = {
  name: "plane_get_context",
  description: "读取上下文",
  inputSchema: { type: "object", properties: { target: { type: "string" } } },
  annotations: { readOnlyHint: true },
  category: "read",
  group: "general_read",
  execution_mode: "direct",
  required_role: "connection read scope",
  availability: {
    enabled: true,
    reason_code: "enabled",
    reason: "当前连接已授权读取。",
    required_connection_scope: "administrative:read or research:read",
    object_level_permission: "live workspace and object ACL",
  },
  usage: {
    when_to_use: "读取对象详情和能力。",
    workflow: ["先定位对象。", "使用稳定 ID 调用。"],
    example: { arguments: { target: "00000000-0000-4000-8000-000000000000" } },
  },
};
const unavailableTool = {
  ...tool,
  name: "plane_create_research_project",
  description: "创建科研项目。",
  category: "direct_write",
  group: "research_lifecycle",
  execution_mode: "direct",
  required_role: "research project owner/admin or chain writer",
  availability: {
    ...tool.availability,
    enabled: false,
    reason_code: "scope_required",
    reason: "当前连接未授权 research:read_write。",
    required_connection_scope: "research:read_write",
  },
  usage: {
    ...tool.usage,
    when_to_use: "创建科研项目。",
    workflow: ["先确认科研项目读写授权。", "传入稳定 request_id。"],
  },
};
const base = {
  contract_version: "plane.unified-mcp.v2",
  connection: {
    id: "connection-id",
    name: "fyk_mcp",
    scope: { include_future_objects: true, workspaces: [] },
    implemented_capabilities: ["read"],
    created_at: "2026-10-31T00:00:00Z",
    expires_at: null,
    configuration_available: true,
    revoked_at: null,
    last_used_at: null,
  },
  server: {
    name: "plane-unified-mcp",
    version: "2.0.0",
    protocol_version: "2025-03-26",
    server_key: "fyk_mcp",
    url: "https://plane.test/api/mcp/",
    auth_header: "Authorization",
    docs_url: "https://plane.test/mcp/api-docs/project/connection-id",
  },
  identity: { user_id: "user-id", display_name: "Fang" },
  workspaces: [
    {
      id: "workspace-id",
      name: "公共工作区",
      slug: "public",
      authorized_domains: { administrative: "read" },
      live_domains: { administrative: "read" },
      live_access: true,
      role_context: { roles: ["MENTOR"] },
    },
  ],
  tools: [tool],
  catalog_mode: "full" as const,
  catalog: [tool, unavailableTool],
  catalog_summary: { total: 2, available: 1, unavailable: 1 },
};

beforeEach(() => {
  container.innerHTML = "";
  root = createRoot(container);
  mocks.project.mockReset().mockResolvedValue(base);
  mocks.weekly.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
});

it("renders a secret-free project API catalogue with live role context", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <MCPApiDocs kind="project" connectionId="connection-id" />
      </StrictMode>
    )
  );
  expect(container.textContent).toContain("fyk_mcp");
  expect(container.textContent).toContain("plane_get_context");
  expect(container.textContent).toContain("MENTOR");
  expect(container.textContent).toContain("完整 API 目录");
  expect(container.textContent).toContain("plane_create_research_project");
  expect(container.textContent).toContain("当前连接未授权 research:read_write");
  expect(container.textContent).toContain("何时使用");
  expect(container.textContent).toContain("推荐步骤");
  expect(container.textContent).toContain("示例参数");
  expect(container.querySelector("a")?.getAttribute("rel")).toContain("noopener");
  expect(container.textContent).not.toContain("pum_SECRET");
});

it("loads the weekly catalogue through its workspace-bound service", async () => {
  const { name: _name, ...connection } = base.connection;
  const weeklyPrepare = {
    ...tool,
    name: "prepare_weekly_report_operation",
    group: "weekly_write_review",
    usage: {
      ...tool.usage,
      action_examples: {
        return: { arguments: { action: "return", comment: "请补充结果。" } },
        accept: { arguments: { action: "accept" } },
      },
    },
  };
  mocks.weekly.mockResolvedValue({
    ...base,
    connection: { ...connection, label: "fyk_report_mcp" },
    tools: [tool],
    catalog: [tool, weeklyPrepare],
    catalog_summary: { total: 2, available: 2, unavailable: 0 },
  });
  await act(async () =>
    root.render(
      <StrictMode>
        <MCPApiDocs kind="weekly-report" connectionId="connection-id" workspaceSlug="public" />
      </StrictMode>
    )
  );
  expect(mocks.weekly).toHaveBeenCalledWith("public", "connection-id");
  expect(container.textContent).toContain("fyk_report_mcp");
  expect(container.textContent).toContain("按动作分支的示例");
  expect(container.textContent).toContain("return");
  expect(container.textContent).toContain("accept");
});

it("filters the complete catalogue to available tools only when requested", async () => {
  mocks.project.mockResolvedValue(base);
  await act(async () =>
    root.render(
      <StrictMode>
        <MCPApiDocs kind="project" connectionId="connection-id" />
      </StrictMode>
    )
  );
  expect(container.textContent).toContain("plane_create_research_project");
  await act(async () => container.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());
  expect(container.textContent).not.toContain("plane_create_research_project");
  expect(container.textContent).toContain("plane_get_context");
});
