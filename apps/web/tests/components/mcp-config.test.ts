/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { expect, it, vi } from "vitest";
vi.mock("@plane/constants", () => ({ API_BASE_URL: "https://plane.test" }));
import { configurationFiles, nativeConfig, researchConfig } from "@/components/mcp/connection-config";
import type { TNativeConnection, TResearchIssued } from "@/services/mcp.service";
it("exports stable distinct service names using each existing protocol and credential", () => {
  const native = nativeConfig({
    id: "same-id",
    mcp_url: "https://native.test/mcp",
    sciencediscovery_json: JSON.stringify({
      mcpServers: { original: { headers: { Authorization: "Bearer independent-native" } } },
    }),
  } as TNativeConnection);
  const research = researchConfig({
    id: "same-id",
    mcp_path: "/api/research/workspaces/lab/agent-access/mcp/",
    headers: { "X-Research-Context-Token": "independent-read", "X-Research-Context-Hash": "scope" },
  } as TResearchIssued);
  const output = configurationFiles([native, research]);
  const json = JSON.parse(output.json).mcpServers;
  expect(Object.keys(json)).toEqual(["plane_admin_same-id", "plane_research_sameid"]);
  expect(json["plane_admin_same-id"].url).toBe("https://native.test/mcp");
  expect(json.plane_research_sameid.url).toBe("https://plane.test/api/research/workspaces/lab/agent-access/mcp/");
  expect(json.plane_research_sameid.headers.Authorization).toBeUndefined();
  expect(output.toml).toContain('"X-Research-Context-Token" = "independent-read"');
  expect(configurationFiles([native, research])).toEqual(output);
});

it.each([
  "",
  "null",
  "[]",
  "{}",
  '{"mcpServers":[]}',
  '{"mcpServers":{}}',
  '{"mcpServers":{"one":null}}',
  '{"mcpServers":{"one":{"headers":{} }}}',
  '{"mcpServers":{"one":{"headers":{"Authorization":42}}}}',
  '{"mcpServers":{"one":{"headers":{"Authorization":""}}}}',
  '{"mcpServers":{"one":{},"two":{}}}',
  '{"secret":"SYNTHETIC-SECRET"',
])("rejects malformed portal configuration without echoing its source (%s)", (sciencediscovery_json) => {
  const create = () =>
    nativeConfig({ id: "synthetic", mcp_url: "https://native.test/mcp", sciencediscovery_json } as TNativeConnection);
  expect(create).toThrow("服务返回的连接配置格式无效，请联系管理员。");
});

it("validates the endpoint and supports the existing embedded endpoint fallback", () => {
  const config = {
    mcpServers: { service: { url: "https://native.test/mcp", headers: { Authorization: "Bearer synthetic" } } },
  };
  const connection = {
    id: "synthetic",
    mcp_url: "",
    sciencediscovery_json: JSON.stringify(config),
  } as TNativeConnection;
  expect(nativeConfig(connection).url).toBe(config.mcpServers.service.url);
  for (const mcp_url of ["invalid", "javascript:alert(1)", "https://user:password@native.test/mcp"]) {
    expect(() => nativeConfig({ ...connection, mcp_url })).toThrow("连接配置格式无效");
  }
});
