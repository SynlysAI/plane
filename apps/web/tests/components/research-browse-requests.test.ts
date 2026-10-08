import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchStore } from "@/store/research/research.store";
import { ResearchReportService } from "@/services/research/report.service";
import { ResearchProjectService } from "@/services/research/project.service";

/** 建立可控网络响应，确定新旧筛选请求的完成顺序。 */
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** 创建只包含列表身份与游标元数据的服务响应。 */
function page(id: string) {
  return { results: [{ id }], next_cursor: `${id}-next`, next_page_results: true, per_page: 1 };
}

afterEach(() => vi.restoreAllMocks());

describe.each(["reports", "projects"] as const)("%s 筛选请求顺序", (kind) => {
  it("旧请求晚返回时不覆盖新筛选结果和分页", async () => {
    const older = pending<ReturnType<typeof page>>();
    const newer = pending<ReturnType<typeof page>>();
    if (kind === "reports") {
      vi.spyOn(ResearchReportService.prototype, "getReports")
        .mockReturnValueOnce(older.promise as never)
        .mockReturnValueOnce(newer.promise as never);
    } else {
      vi.spyOn(ResearchProjectService.prototype, "getProjects")
        .mockReturnValueOnce(older.promise as never)
        .mockReturnValueOnce(newer.promise as never);
    }
    const store = new ResearchStore({} as never);
    const fetch = (q: string) =>
      kind === "reports" ? store.fetchReports("lab", { q }) : store.fetchResearchProjects("lab", { q });
    const first = fetch("old-filter");
    const second = fetch("new-filter");
    newer.resolve(page("new"));
    await second;
    older.resolve(page("old"));
    await first;

    const visible = kind === "reports" ? store.getReports("lab") : store.getResearchProjects("lab");
    const pagination =
      kind === "reports" ? store.reportPaginationByWorkspace.lab : store.projectPaginationByWorkspace.lab;
    expect(visible.map((item) => item.id)).toEqual(["new"]);
    expect(pagination?.next_cursor).toBe("new-next");
  });

  it("旧请求完成后新请求仍加载，旧请求失败不清除最新结果", async () => {
    const older = pending<ReturnType<typeof page>>();
    const newer = pending<ReturnType<typeof page>>();
    if (kind === "reports") {
      vi.spyOn(ResearchReportService.prototype, "getReports")
        .mockReturnValueOnce(older.promise as never)
        .mockReturnValueOnce(newer.promise as never);
    } else {
      vi.spyOn(ResearchProjectService.prototype, "getProjects")
        .mockReturnValueOnce(older.promise as never)
        .mockReturnValueOnce(newer.promise as never);
    }
    const store = new ResearchStore({} as never);
    const fetch = (q: string) =>
      kind === "reports" ? store.fetchReports("lab", { q }) : store.fetchResearchProjects("lab", { q });
    const first = fetch("old-filter").catch(() => undefined);
    const second = fetch("new-filter");
    older.reject(new Error("stale network failure"));
    await first;

    expect(kind === "reports" ? store.reportLoader : store.projectLoader).toBe(true);
    newer.resolve(page("new"));
    await second;
    expect(kind === "reports" ? store.reportLoader : store.projectLoader).toBe(false);
    expect(
      (kind === "reports" ? store.getReports("lab") : store.getResearchProjects("lab")).map((item) => item.id)
    ).toEqual(["new"]);
  });
});
