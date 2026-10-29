// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  fetchReportAttachments: vi.fn(),
  uploadReportAttachment: vi.fn(),
  deleteReportAttachment: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      if (typeof value !== "string") return key;
      return value.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? ""));
    },
  }),
}));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    reportAttachments: {},
    fetchReportAttachments: mocks.fetchReportAttachments,
    uploadReportAttachment: mocks.uploadReportAttachment,
    deleteReportAttachment: mocks.deleteReportAttachment,
  }),
}));
vi.mock("@/components/attachments/preview", () => ({
  AttachmentPreviewLink: ({ name }: { name: string }) => <span>{name}</span>,
}));

const { ResearchReportAttachments } = await import("@/components/research/reports/report-attachments");

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: Root;

/** 挂载报告附件区。 */
async function mount() {
  await act(async () => {
    root.render(<ResearchReportAttachments workspaceSlug="lab" reportId="report-1" editable />);
  });
  await act(async () => await Promise.resolve());
}

/** 通过文件选择事件提交批次。 */
async function selectFiles(files: File[]) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("上传入口未显示");
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => await Promise.resolve());
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.fetchReportAttachments.mockResolvedValue([]);
  mocks.uploadReportAttachment.mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("uploads a flattened batch in order", async () => {
  await mount();
  const files = [
    new File(["first"], "first.pdf", { type: "application/pdf" }),
    new File(["second"], "second.md", { type: "text/markdown" }),
  ];
  await selectFiles(files);

  expect(mocks.uploadReportAttachment).toHaveBeenCalledTimes(2);
  expect(mocks.uploadReportAttachment).toHaveBeenNthCalledWith(1, "lab", "report-1", {
    file_name: "first.pdf",
    content_type: "application/pdf",
    size: files[0].size,
    body: files[0],
  });
  expect(mocks.uploadReportAttachment).toHaveBeenNthCalledWith(2, "lab", "report-1", {
    file_name: "second.md",
    content_type: "text/markdown",
    size: files[1].size,
    body: files[1],
  });
});

it("continues a batch after an individual upload fails and reports the failure count", async () => {
  mocks.uploadReportAttachment.mockRejectedValueOnce(new Error("storage unavailable"));
  await mount();
  await selectFiles([
    new File(["first"], "first.pdf", { type: "application/pdf" }),
    new File(["second"], "second.pdf", { type: "application/pdf" }),
  ]);

  expect(mocks.uploadReportAttachment).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("1 个附件上传失败，其余 1 个已上传。");
});
