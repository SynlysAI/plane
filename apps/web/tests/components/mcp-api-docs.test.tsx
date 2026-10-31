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
const root = createRoot(container);

const tool = {
  name: "plane_get_context",
  description: "读取上下文",
  inputSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
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
      role_context: { roles: ["MENTOR"], org_units: [{ id: "unit-id", role: "PI" }] },
    },
  ],
  tools: [tool],
  catalog_mode: "full" as const,
  catalog: [tool, unavailableTool],
  catalog_summary: { total: 2, available: 1, unavailable: 1 },
};

function input(label: string) {
  return container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
}

async function change(label: string, value: string) {
  const element = input(label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(element.constructor.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(label: string) {
  const element = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.includes(label) || item.getAttribute("aria-label") === label
  );
  expect(element, label).toBeTruthy();
  await act(async () => element!.click());
}

beforeEach(() => {
  container.innerHTML = "";
  root.render(null);
  mocks.project.mockReset().mockResolvedValue(base);
  mocks.weekly.mockReset();
});

afterEach(async () => {
  await act(async () => root.render(null));
});

it("renders a dense scrollable catalogue with index, summary and detail", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <MCPApiDocs kind="project" connectionId="connection-id" />
      </StrictMode>
    )
  );
  const page = container.querySelector('[data-testid="mcp-api-docs-page"]')!;
  const index = container.querySelector('[data-testid="mcp-api-index"]')!;
  const detail = container.querySelector('[data-testid="mcp-api-detail"]')!;
  expect(page.className).toContain("h-full");
  expect(page.className).toContain("min-h-0");
  expect(index.className).toContain("md:overflow-y-auto");
  expect(detail.className).toContain("md:overflow-y-auto");
  expect(container.textContent).toContain("fyk_mcp");
  expect(container.textContent).toContain("全部 2");
  expect(container.textContent).toContain("可用 1");
  expect(container.textContent).toContain("未授权 1");
  expect(container.textContent).toContain("通用读取1/1");
  expect(container.textContent).toContain("科研项目 / 研究链 / 节点0/1");
  expect(container.textContent).toContain("plane_get_context");
  expect(container.textContent).toContain("plane_create_research_project");
  expect(container.textContent).toContain("MENTOR");
  expect(container.textContent).toContain("组织单元：1");
  expect(container.querySelector("a")?.getAttribute("rel")).toContain("noopener");
  expect(container.textContent).not.toContain("pum_SECRET");
});

it("switches detail through the index and switches schema tabs", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <MCPApiDocs kind="project" connectionId="connection-id" />
      </StrictMode>
    )
  );
  expect(container.textContent).toContain("读取对象详情和能力");
  await click("plane_create_research_project");
  expect(container.textContent).toContain("创建科研项目。");
  expect(container.textContent).toContain("当前连接未授权 research:read_write");
  await click("Input schema");
  expect(container.querySelector('[role="tabpanel"]')!.textContent).toContain('"required"');
});

it("searches by tool name and usage, and shows an empty state", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <MCPApiDocs kind="project" connectionId="connection-id" />
      </StrictMode>
    )
  );
  await change("搜索 API", "创建科研");
  expect(container.textContent).toContain("plane_create_research_project");
  expect(container.textContent).not.toContain("plane_get_context");
  await change("搜索 API", "不存在的 API");
  expect(container.textContent).toContain("没有匹配的 API");
  await act(async () => {
    const search = input("搜索 API") as HTMLInputElement;
    search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  expect((input("搜索 API") as HTMLInputElement).value).toBe("");
});

it("filters by availability and group", async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <MCPApiDocs kind="project" connectionId="connection-id" />
      </StrictMode>
    )
  );
  const groupNavigation = container.querySelector('[aria-label="API 分组导航"]')!;
  const groupButtons = Array.from(groupNavigation.querySelectorAll<HTMLButtonElement>("button"));
  expect(groupButtons.map((button) => button.textContent)).toEqual(["全部", "通用读取", "科研项目 / 研究链 / 节点"]);
  await click("科研项目 / 研究链 / 节点");
  expect(groupButtons.at(-1)?.getAttribute("aria-current")).toBe("true");
  expect(container.querySelector('[data-testid="mcp-api-index"]')!.textContent).not.toContain("plane_get_context");
  await click("全部");
  await change("状态筛选", "unavailable");
  expect(container.textContent).toContain("plane_create_research_project");
  expect(container.querySelector('[data-testid="mcp-api-index"]')!.textContent).not.toContain("plane_get_context");
  await change("状态筛选", "all");
  await change("分组筛选", "general_read");
  expect(container.textContent).toContain("plane_get_context");
  expect(container.textContent).not.toContain("plane_create_research_project");
});

it("loads weekly docs and exposes action examples through the action matrix", async () => {
  const { name: _name, ...connection } = base.connection;
  const weeklyPrepare = {
    ...tool,
    name: "prepare_weekly_report_operation",
    group: "weekly_write_review",
    availability: { ...tool.availability, required_actions: ["read_reports"] },
    action_availability: {
      save_draft: { ...tool.availability, required_actions: ["save_draft"] },
      return: { ...tool.availability, enabled: false, reason: "当前连接未授权 return。", required_actions: ["return"] },
    },
    usage: {
      ...tool.usage,
      action_examples: {
        save_draft: { arguments: { action: "save_draft" } },
        return: { arguments: { action: "return", comment: "请补充结果。" } },
      },
    },
  };
  mocks.weekly.mockResolvedValue({
    ...base,
    connection: { ...connection, label: "fyk_report_mcp" },
    tools: [tool],
    catalog: [tool, weeklyPrepare],
    catalog_summary: { total: 2, available: 2, unavailable: 0 },
    workspaces: [
      {
        ...base.workspaces[0],
        authorized_actions: ["read_reports", "save_draft"],
        live_actions: ["read_reports", "save_draft"],
      },
    ],
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
  await click("prepare_weekly_report_operation");
  expect(container.textContent).toContain("周报动作授权");
  await click("动作示例");
  expect(container.querySelector('[role="tabpanel"]')!.textContent).toContain("save_draft");
  await click("return");
  expect(container.querySelector('[role="tabpanel"]')!.textContent).toContain("请补充结果。");
});
