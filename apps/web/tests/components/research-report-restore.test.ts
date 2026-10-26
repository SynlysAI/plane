import { expect, it, vi } from "vitest";

import { ResearchStore } from "@/store/research/research.store";
import { ResearchReportService } from "@/services/research/report.service";
import type { CoreRootStore } from "@/store/root.store";

it("报告恢复服务调用专用端点", async () => {
  const service = new ResearchReportService();
  const report = { id: "report-1", status: "DRAFT", deleted_at: null, can_restore: false };
  const post = vi.spyOn(service, "post").mockResolvedValue({ data: report } as never);

  await expect(service.restoreReport("lab", "report-1")).resolves.toBe(report);
  expect(post).toHaveBeenCalledWith("/api/research/workspaces/lab/reports/report-1/restore/", {});
  vi.restoreAllMocks();
});

it("恢复报告后更新 research store 缓存", async () => {
  const store = new ResearchStore({} as CoreRootStore);
  const report = { id: "report-1", status: "DRAFT", deleted_at: null, can_restore: false };
  vi.spyOn(ResearchReportService.prototype, "restoreReport").mockResolvedValue(report as never);

  await expect(store.restoreReport("lab", "report-1")).resolves.toBe(report);
  expect(store.reports["report-1"]).toEqual(report);
  vi.restoreAllMocks();
});
