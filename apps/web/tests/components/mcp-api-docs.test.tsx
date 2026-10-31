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
  execution_mode: "direct",
  required_role: "connection read scope",
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
  expect(container.querySelector("a")?.getAttribute("rel")).toContain("noopener");
  expect(container.textContent).not.toContain("pum_SECRET");
});

it("loads the weekly catalogue through its workspace-bound service", async () => {
  const { name: _name, ...connection } = base.connection;
  mocks.weekly.mockResolvedValue({
    ...base,
    connection: { ...connection, label: "fyk_report_mcp" },
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
});
