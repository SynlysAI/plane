import { expect, it, vi } from "vitest";

import { ResearchStore } from "@/store/research/research.store";
import { ResearchReportService } from "@/services/research/report.service";
import type { CoreRootStore } from "@/store/root.store";

it("报告撤回服务调用专用端点", async () => {
  const service = new ResearchReportService();
  const report = { id: "report-1", status: "DRAFT", submitted_at: null };
  const post = vi.spyOn(service, "post").mockResolvedValue({ data: report } as never);

  await expect(service.withdrawReport("lab", "report-1", "补充实验参数")).resolves.toBe(report);
  expect(post).toHaveBeenCalledWith("/api/research/workspaces/lab/reports/report-1/withdraw/", {
    comment: "补充实验参数",
  });
  vi.restoreAllMocks();
});

it("报告撤回后更新 store 缓存并读取历史", async () => {
  const store = new ResearchStore({} as CoreRootStore);
  const report = { id: "report-1", status: "DRAFT", submitted_at: null };
  vi.spyOn(ResearchReportService.prototype, "withdrawReport").mockResolvedValue(report as never);
  const getHistory = vi.spyOn(ResearchReportService.prototype, "getReportHistory").mockResolvedValue({
    results: [],
    count: 0,
  } as never);

  await expect(store.withdrawReport("lab", "report-1", "补充实验参数")).resolves.toBe(report);
  expect(store.reports["report-1"]).toEqual(report);
  expect(getHistory).toHaveBeenCalledWith("lab", "report-1");
  vi.restoreAllMocks();
});
