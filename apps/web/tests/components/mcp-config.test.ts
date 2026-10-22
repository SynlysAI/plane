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
