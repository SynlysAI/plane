// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TCommentAttachment } from "@plane/types";
import {
  getCommentAttachmentCategory,
  getCommentAttachmentLimitError,
} from "@/components/comments/comment-attachment-limits";
import { useCommentAttachments } from "@/components/comments/use-comment-attachments";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let state: ReturnType<typeof useCommentAttachments>;
const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const upload = vi.fn();
const discard = vi.fn().mockResolvedValue(undefined);
const MEGABYTE = 1024 * 1024;
const limits = {
  image: { max_mb: 1, max_bytes: MEGABYTE },
  pdf: { max_mb: 2, max_bytes: 2 * MEGABYTE },
  markdown: { max_mb: 3, max_bytes: 3 * MEGABYTE },
  office: { max_mb: 4, max_bytes: 4 * MEGABYTE },
};
const existing: TCommentAttachment = {
  id: "existing",
  name: "原材料.pptx",
  size: 10,
  type: "application/octet-stream",
  download_url: "/download/existing",
};

/** 将真实上传队列挂载在最小 React 容器中。 */
async function mount(initial: TCommentAttachment[] = []) {
  function Harness() {
    state = useCommentAttachments(
      { uploadCommentAttachment: upload, discardCommentAttachment: discard },
      limits,
      initial
    );
    return null;
  }
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  vi.clearAllMocks();
});

it("blocks submission during upload and permits attachment-only content after success", async () => {
  let finish!: (file: TCommentAttachment) => void;
  upload.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  await mount();
  await act(async () => state.addFiles([new File(["pptx"], "过程.pptx")]));
  expect(state.isBlocked).toBe(true);
  expect(state.attachmentIds).toEqual([]);
  await act(async () => finish({ ...existing, id: "new" }));
  expect(state.isBlocked).toBe(false);
  expect(state.attachmentIds).toEqual(["new"]);
});

it("retains successful files when another upload fails and supports retry", async () => {
  upload.mockResolvedValueOnce(existing).mockRejectedValueOnce(new Error("offline"));
  await mount();
  await act(async () => state.addFiles([new File(["a"], "a.pptx"), new File(["b"], "b.pdf")]));
  expect(state.attachmentIds).toEqual(["existing"]);
  expect(state.isBlocked).toBe(true);
  const failed = state.entries.find((entry) => entry.status === "failed")!;
  upload.mockResolvedValueOnce({ ...existing, id: "retry" });
  await act(async () => state.retry(failed.key));
  expect(state.attachmentIds).toEqual(["existing", "retry"]);
  expect(state.isBlocked).toBe(false);
});

it("classifies comment attachments consistently", () => {
  expect(getCommentAttachmentCategory(new File(["a"], "图版.png", { type: "image/png" }))).toBe("image");
  expect(getCommentAttachmentCategory(new File(["a"], "论文.pdf", { type: "application/pdf" }))).toBe("pdf");
  expect(getCommentAttachmentCategory(new File(["a"], "记录.markdown", { type: "text/markdown" }))).toBe("markdown");
  expect(getCommentAttachmentCategory(new File(["a"], "记录.md", { type: "text/x-markdown" }))).toBe("markdown");
  expect(getCommentAttachmentCategory(new File(["a"], "汇报.pptx", { type: "application/octet-stream" }))).toBe(
    "office"
  );
  expect(getCommentAttachmentCategory(new File(["a"], "数据.zip", { type: "application/zip" }))).toBe("office");
  expect(getCommentAttachmentLimitError(limits, new File(["a"], "记录.md", { type: "text/markdown" }))).toBeNull();
});

it("enforces category size and count before upload", async () => {
  await mount(Array.from({ length: 9 }, (_, i) => ({ ...existing, id: String(i) })));
  const largePdf = new File(["pdf"], "large.pdf", { type: "application/pdf" });
  Object.defineProperty(largePdf, "size", { value: 2 * MEGABYTE + 1 });
  await act(async () => state.addFiles([largePdf]));
  expect(upload).not.toHaveBeenCalled();
  expect(state.error).toBe("PDF 文件不能超过 2 MB。");
  await act(async () => state.addFiles([new File(["a"], "a.pdf"), new File(["b"], "b.pdf")]));
  expect(upload).not.toHaveBeenCalled();
  expect(state.entries).toHaveLength(9);
});

it("uses each category limit and rejects the whole mixed batch when one file exceeds it", async () => {
  await mount();
  const largeImage = new File(["png"], "large.png", { type: "image/png" });
  Object.defineProperty(largeImage, "size", { value: MEGABYTE + 1 });
  await act(async () => state.addFiles([largeImage, new File(["pdf"], "ok.pdf", { type: "application/pdf" })]));
  expect(upload).not.toHaveBeenCalled();
  expect(state.error).toBe("图片文件不能超过 1 MB。");
  expect(state.entries).toEqual([]);
});

it("blocks new attachments when project limits cannot be loaded", async () => {
  function FailedHarness() {
    state = useCommentAttachments({ uploadCommentAttachment: upload, discardCommentAttachment: discard }, null, []);
    return null;
  }
  root = createRoot(container);
  await act(async () => root.render(<FailedHarness />));
  await act(async () => state.addFiles([new File(["a"], "a.pdf")]));
  expect(upload).not.toHaveBeenCalled();
  expect(state.error).toBe("无法获取当前工作区附件限制");
  expect(state.entries).toEqual([]);
});

it("removing original attachments is local until save and cancel discards only new files", async () => {
  upload.mockResolvedValueOnce({ ...existing, id: "new" });
  await mount([existing]);
  await act(async () => state.remove("existing"));
  expect(discard).not.toHaveBeenCalled();
  await act(async () => state.addFiles([new File(["a"], "new.pdf")]));
  await act(async () => state.cancel());
  expect(discard).toHaveBeenCalledExactlyOnceWith("new");
  expect(state.attachmentIds).toEqual(["existing"]);
});

it("cleans a late upload removed before completion", async () => {
  let finish!: (file: TCommentAttachment) => void;
  upload.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  await mount();
  await act(async () => state.addFiles([new File(["a"], "new.pdf")]));
  await act(async () => state.remove(state.entries[0].key));
  await act(async () => finish({ ...existing, id: "late" }));
  expect(discard).toHaveBeenCalledWith("late");
  expect(state.entries).toEqual([]);
});
