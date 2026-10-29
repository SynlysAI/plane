import { beforeEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), create: vi.fn() }));
vi.mock("@plane/constants", () => ({ API_BASE_URL: "https://plane.test" }));
vi.mock("axios", () => ({ create: calls.create.mockReturnValue({ get: calls.get, post: calls.post }) }));
import { WeeklyReportMCPService } from "@/services/weekly-report-mcp.service";
import { weeklyReportConfig } from "@/components/mcp/weekly-report-config";
import type { WeeklyReportIssued } from "@/services/weekly-report-mcp.service";
beforeEach(() => {
  vi.clearAllMocks();
  calls.get.mockResolvedValue({ data: {} });
  calls.post.mockResolvedValue({ data: {} });
});

it("uses dedicated management routes, login cookies and CSRF; no machine or node identity", async () => {
  const service = new WeeklyReportMCPService();
  expect(calls.create).toHaveBeenCalledWith({ baseURL: "https://plane.test", withCredentials: true, timeout: 30_000 });
  await service.options();
  expect(calls.get).toHaveBeenLastCalledWith("/api/research/mcp/weekly-report/options/");
  await service.connections("a/b", "cursor");
  expect(calls.get).toHaveBeenLastCalledWith("/api/research/workspaces/a%2Fb/mcp/weekly-report/connections/", {
    params: { cursor: "cursor" },
  });
  const payload = { label: "本人", actions: ["submit" as const], ttl_days: 7 };
  await service.issue("a/b", payload, "csrf");
  expect(calls.post).toHaveBeenLastCalledWith(
    "/api/research/workspaces/a%2Fb/mcp/weekly-report/connections/",
    payload,
    { headers: { "X-CSRFToken": "csrf" } }
  );
  await service.revoke("a/b", "grant/id", "csrf2");
  expect(calls.post).toHaveBeenLastCalledWith(
    "/api/research/workspaces/a%2Fb/mcp/weekly-report/connections/grant%2Fid/revoke/",
    {},
    { headers: { "X-CSRFToken": "csrf2" } }
  );
});

it.each([undefined, 503, 403, 409])(
  "sanitizes errors and marks ambiguous writes without retrying (status=%s)",
  async (status) => {
    calls.post.mockRejectedValue({
      message: "SECRET",
      config: { data: "SECRET" },
      response: status ? { status, data: { error_code: "grant_limit", message: "SECRET" } } : undefined,
    });
    const request = new WeeklyReportMCPService().issue(
      "public",
      { label: "本人", actions: ["save_draft"], ttl_days: 1 },
      "csrf"
    );
    await expect(request).rejects.toMatchObject({ status, uncertain: status === undefined || status >= 500 });
    await expect(request).rejects.not.toHaveProperty("config");
    await request.catch((error) => expect(JSON.stringify(error)).not.toContain("SECRET"));
    expect(calls.post).toHaveBeenCalledTimes(1);
  }
);

const issued = () =>
  ({
    id: "11111111-2222-4333-8444-555555555555",
    workspace: "public",
    mcp_path: "/api/research/workspaces/public/weekly-report-agent/mcp/",
    headers: { "X-Weekly-Report-Token": `pwr_${"a".repeat(43)}`, Authorization: "must-not-copy" },
  }) as WeeklyReportIssued;
it("copies only the dedicated weekly header into a distinct service name", () => {
  const value = weeklyReportConfig(issued(), "public");
  expect(value.name).toBe("plane_weekly_report_11111111222243338444555555555555");
  expect(value.headers).not.toHaveProperty("Authorization");
});
it.each([
  { workspace: "other" },
  { id: "unsafe.name" },
  { headers: {} },
  { headers: { "X-Weekly-Report-Token": "SECRET" } },
  { mcp_path: "https://evil.test/api/research/workspaces/public/weekly-report-agent/mcp/" },
  { mcp_path: "/api/research/workspaces/public/weekly-report-agent/mcp/?token=SECRET" },
  { mcp_path: "/api/research/workspaces/other/weekly-report-agent/mcp/" },
  { mcp_path: "javascript:SECRET" },
])("rejects malformed credentials/paths with a fixed non-sensitive error (%j)", (override) => {
  expect(() => weeklyReportConfig({ ...issued(), ...override }, "public")).toThrow(
    "连接配置无效，请核对已有连接后重新创建。"
  );
});
