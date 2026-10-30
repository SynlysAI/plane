import { beforeEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), create: vi.fn() }));
vi.mock("@plane/constants", () => ({ API_BASE_URL: "https://plane.test" }));
vi.mock("axios", () => ({
  create: (options: unknown) => {
    calls.create(options);
    return { get: calls.get, post: calls.post };
  },
}));
import { UnifiedMCPService } from "@/services/unified-mcp.service";
beforeEach(() => {
  vi.clearAllMocks();
  calls.get.mockResolvedValue({ data: {} });
  calls.post.mockResolvedValue({ data: {} });
});
it("uses a human session and only session CSRF on one unified issuance/revoke", async () => {
  const service = new UnifiedMCPService();
  expect(calls.create).toHaveBeenCalledWith({ baseURL: "https://plane.test", withCredentials: true, timeout: 30_000 });
  await service.options("next-options");
  expect(calls.get).toHaveBeenLastCalledWith("/api/mcp/connections/options/", { params: { cursor: "next-options" } });
  await service.connections("next-connections");
  expect(calls.get).toHaveBeenLastCalledWith("/api/mcp/connections/", { params: { cursor: "next-connections" } });
  const payload = {
    name: "One agent",
    include_future_objects: true,
    workspaces: [
      { workspace_id: "one", domains: { administrative: "read" as const, research: "read_write" as const } },
    ],
  };
  await service.issue(payload, "human-csrf");
  expect(calls.post).toHaveBeenLastCalledWith("/api/mcp/connections/", payload, {
    headers: { "X-CSRFToken": "human-csrf" },
  });
  await service.revoke("connection/id", "human-csrf");
  expect(calls.post).toHaveBeenLastCalledWith(
    "/api/mcp/connections/connection%2Fid/revoke/",
    {},
    { headers: { "X-CSRFToken": "human-csrf" } }
  );
});
it.each(["configuration", "rotate"] as const)("通过本人会话与 CSRF 请求 %s 配置", async (action) => {
  const service = new UnifiedMCPService();
  await service[action]("a/b", "csrf");
  expect(calls.post).toHaveBeenLastCalledWith(
    `/api/mcp/connections/a%2Fb/${action}/`,
    {},
    { headers: { "X-CSRFToken": "csrf" } }
  );
});
it("retains a bounded status/code for an error without storing the whole transport response", async () => {
  calls.post.mockRejectedValue({
    response: { status: 409, data: { error_code: "grant_limit", message: "Limit", other: "ignored" } },
  });
  await expect(
    new UnifiedMCPService().issue({ name: "One", workspaces: [], include_future_objects: true }, "csrf")
  ).rejects.toEqual({ status: 409, code: "grant_limit", message: "Limit" });
});
