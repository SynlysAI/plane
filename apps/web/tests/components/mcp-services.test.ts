/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@plane/constants", () => ({ API_BASE_URL: "https://plane.test" }));
vi.mock("@/services/api.service", () => ({
  APIService: class {
    get = calls.get;
    post = calls.post;
  },
}));
vi.mock("axios", () => ({ create: () => ({ get: calls.get, post: calls.post }) }));
import { NativeMCPService, ResearchMCPService } from "@/services/mcp.service";

beforeEach(() => {
  vi.clearAllMocks();
  calls.get.mockResolvedValue({ data: {} });
  calls.post.mockResolvedValue({ data: {} });
});

it("sends both human CSRF values only to the native bridge", async () => {
  await new NativeMCPService().write("tokens", { workspace: "public" }, "plane-csrf", "native-csrf");
  expect(calls.post).toHaveBeenCalledWith(
    "/api/mcp/native/tokens/",
    { workspace: "public" },
    {
      headers: { "X-CSRFToken": "plane-csrf", "X-MCP-CSRF": "native-csrf" },
    }
  );
});

it("uses only session CSRF on research issuance and revocation, preserving workspace and grant routes", async () => {
  const service = new ResearchMCPService();
  const payload = { node_id: "node", label: "Read", mode: "read" as const, actions: [] };
  await service.issue("workspace", payload, "research-csrf");
  expect(calls.post).toHaveBeenLastCalledWith("/api/research/workspaces/workspace/mcp/connections/", payload, {
    headers: { "X-CSRFToken": "research-csrf" },
  });
  await service.revoke("workspace", "grant", "research-csrf");
  expect(calls.post).toHaveBeenLastCalledWith(
    "/api/research/workspaces/workspace/mcp/connections/grant/revoke/",
    {},
    { headers: { "X-CSRFToken": "research-csrf" } }
  );
  await service.candidates("workspace", { q: "node", chain_id: "chain", cursor: "next" });
  expect(calls.get).toHaveBeenLastCalledWith("/api/research/workspaces/workspace/mcp/candidates/", {
    params: { q: "node", chain_id: "chain", cursor: "next" },
  });
});

it("does not turn a native service rejection into successful connection data", async () => {
  calls.post.mockRejectedValue({ response: { status: 403, data: { error: "Not allowed" } } });
  await expect(new NativeMCPService().write("tokens", {}, "csrf", "native")).rejects.toEqual({
    status: 403,
    message: "Not allowed",
  });
});

it("keeps an unverified native session as a local 401 without the Plane logout interceptor", async () => {
  calls.get.mockRejectedValue({ response: { status: 401, data: { error: "Verify native identity" } } });
  await expect(new NativeMCPService().read("session")).rejects.toEqual({
    status: 401,
    message: "Verify native identity",
  });
});
