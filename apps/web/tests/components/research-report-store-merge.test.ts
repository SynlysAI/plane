import { expect, it, vi } from "vitest";
import { ResearchStore } from "@/store/research/research.store";
import { ResearchReportService } from "@/services/research/report.service";
import type { CoreRootStore } from "@/store/root.store";

/** 列表接口不返回报告正文；刷新列表时必须保留详情接口已带回的正文，否则打开中的报告详情会退回“加载中”。 */
it("fetchReports keeps the report body fetched by fetchReport", async () => {
  const store = new ResearchStore({} as CoreRootStore);
  const body = {
    description_json: { type: "doc" },
    description_html: "<p>周报正文</p>",
    description_stripped: "周报正文",
  };

  vi.spyOn(ResearchReportService.prototype, "getReport").mockResolvedValue({
    id: "r1",
    status: "DRAFT",
    owner: "u1",
    can_edit: true,
    draft_content: body,
    official_content: null,
  } as never);
  vi.spyOn(ResearchReportService.prototype, "getReports").mockResolvedValue({
    results: [{ id: "r1", status: "DRAFT", owner: "u1", official_content: null }],
  } as never);
  try {
    await store.fetchReport("lab", "r1");
    await store.fetchReports("lab");

    expect(store.reports["r1"]?.draft_content).toEqual(body);
    // 列表行自身的字段（如状态）仍然以最新响应为准。
    expect(store.reports["r1"]?.status).toEqual("DRAFT");
  } finally {
    vi.restoreAllMocks();
  }
});

/** 读者视角列表行带 official_content 时，以列表响应为准，不回退旧快照。 */
it("fetchReports refreshes official_content from the list response", async () => {
  const store = new ResearchStore({} as CoreRootStore);
  const stale = { version_no: 1, description_html: "<p>v1</p>" };
  const fresh = { version_no: 2, description_html: "<p>v2</p>" };

  vi.spyOn(ResearchReportService.prototype, "getReport").mockResolvedValue({
    id: "r2",
    status: "SUBMITTED",
    owner: "u2",
    official_content: stale,
  } as never);
  vi.spyOn(ResearchReportService.prototype, "getReports").mockResolvedValue({
    results: [{ id: "r2", status: "SUBMITTED", owner: "u2", official_content: fresh }],
  } as never);
  try {
    await store.fetchReport("lab", "r2");
    await store.fetchReports("lab");

    expect(store.reports["r2"]?.official_content).toEqual(fresh);
  } finally {
    vi.restoreAllMocks();
  }
});
