// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TResearchAgentSessionApi } from "@/components/research/agent/use-research-agent-session";

const mocks = vi.hoisted(() => ({ getFormalReports: vi.fn() }));
vi.mock("@/services/research/agent.service", () => ({
  ResearchAgentService: class {
    getFormalReports = mocks.getFormalReports;
  },
}));

const { ReportContextSelector } = await import("@/components/research/agent/report-context-selector");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const option = { report_id: "report-1", version_no: 3, title: "2026-W40 周报", characters: 128 };

/** 使用真实 React 选择状态，供报告版本和错误展示验证。 */
function SelectorProbe({ node = "node-1", reportError = "" }: { node?: string; reportError?: string }) {
  const [reports, setReports] = React.useState<{ report_id: string; version_no: number }[]>([]);
  const api = {
    workspaceSlug: "lab",
    session: { chain_node: node },
    reports,
    setReports,
    sending: false,
    reportError,
  } as TResearchAgentSessionApi;
  return (
    <>
      <ReportContextSelector api={api} />
      <output aria-label="选择版本">{JSON.stringify(reports)}</output>
    </>
  );
}

/** 生成可控报告列表响应，验证切换课题后忽略旧请求。 */
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getFormalReports.mockResolvedValue({
    results: [option],
    association_hint: "无项目报告需先关联当前课题。办公附件仅列元数据，尚未解析。",
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it("显示报告名称与正式版本，选择时保存明确版本并提示关联要求", async () => {
  await act(async () => root.render(<SelectorProbe />));
  expect(mocks.getFormalReports).toHaveBeenCalledWith("lab", "node-1");
  expect(container.textContent).toContain("2026-W40 周报");
  expect(container.textContent).toContain("正式版本 v3");
  expect(container.textContent).toContain("无项目报告需先关联当前课题");
  expect(container.textContent).toContain("尚未解析");

  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());

  expect(container.querySelector('output[aria-label="选择版本"]')?.textContent).toBe(
    '[{"report_id":"report-1","version_no":3}]'
  );
  expect(container.textContent).toContain("正式报告上下文 · 1 份");
});

it("报告内容读取失败显示原因，列表读取失败可刷新重试", async () => {
  mocks.getFormalReports.mockRejectedValueOnce(new Error("unavailable"));
  await act(async () => root.render(<SelectorProbe />));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("正式报告读取失败");
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());
  expect(container.textContent).toContain("2026-W40 周报");

  await act(async () => root.render(<SelectorProbe reportError="正式版本已变化，请重新选择报告。" />));

  expect(container.querySelector('[role="alert"]')?.textContent).toContain("正式版本已变化");
});

it("课题切换后迟到列表不覆盖当前可见报告", async () => {
  const old = pending<{ results: (typeof option)[]; association_hint: string }>();
  const fresh = pending<{ results: (typeof option)[]; association_hint: string }>();
  mocks.getFormalReports.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  await act(async () => root.render(<SelectorProbe node="old-node" />));
  await act(async () => root.render(<SelectorProbe node="new-node" />));
  await act(async () => fresh.resolve({ results: [{ ...option, title: "新课题正式报告" }], association_hint: "new" }));
  await act(async () => old.resolve({ results: [{ ...option, title: "旧课题迟到报告" }], association_hint: "old" }));

  expect(container.textContent).toContain("新课题正式报告");
  expect(container.textContent).not.toContain("旧课题迟到报告");
});

it("所选正文超限明确提示减少报告选择", async () => {
  mocks.getFormalReports.mockResolvedValue({ results: [{ ...option, characters: 50001 }], association_hint: "" });
  await act(async () => root.render(<SelectorProbe />));
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click());

  expect(container.querySelector('[role="alert"]')?.textContent).toContain("正文超过 50,000 字符");
});
