import { describe, expect, it, vi } from "vitest";

import { ResearchReportService } from "@/services/research/report.service";

describe("ResearchReportService Markdown 导出", () => {
  it("返回后端导出的 ZIP Blob 并调用专用端点", async () => {
    const service = new ResearchReportService();
    const zip = new Blob(["ZIP"], { type: "application/zip" });
    const post = vi.spyOn(service, "post").mockResolvedValue({ data: zip } as never);

    await expect(service.exportMarkdown("lab", "report-1", "# 周报")).resolves.toBe(zip);
    expect(post).toHaveBeenCalledWith(
      "/api/research/workspaces/lab/reports/report-1/export-markdown/",
      { content: "# 周报" },
      { responseType: "blob" }
    );
  });

  it("解析 Blob 形式的 JSON 错误响应", async () => {
    const service = new ResearchReportService();
    const errorBlob = new Blob([JSON.stringify({ error_code: "file_type_not_allowed" })], {
      type: "application/json",
    });
    vi.spyOn(service, "post").mockRejectedValue({ response: { data: errorBlob } } as never);

    await expect(service.exportMarkdown("lab", "report-1", "# 周报")).rejects.toEqual({
      error_code: "file_type_not_allowed",
    });
  });

  it("无法解析错误 Blob 时保留原始 Blob 抛出", async () => {
    const service = new ResearchReportService();
    const errorBlob = new Blob(["not-json"], { type: "application/json" });
    vi.spyOn(service, "post").mockRejectedValue({ response: { data: errorBlob } } as never);

    await expect(service.exportMarkdown("lab", "report-1", "# 周报")).rejects.toBe(errorBlob);
  });
});
