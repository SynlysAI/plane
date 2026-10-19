// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TCommentAttachment } from "@plane/types";
import { useCommentAttachments } from "@/components/comments/use-comment-attachments";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let state: ReturnType<typeof useCommentAttachments>;
const container = document.createElement("div");
let root: ReturnType<typeof createRoot>;
const upload = vi.fn();
const discard = vi.fn().mockResolvedValue(undefined);
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
      1024,
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

it("enforces size and count before upload", async () => {
  await mount(Array.from({ length: 9 }, (_, i) => ({ ...existing, id: String(i) })));
  await act(async () => state.addFiles([new File([new Uint8Array(1025)], "large.pptx")]));
  expect(upload).not.toHaveBeenCalled();
  expect(state.error).toBeTruthy();
  await act(async () => state.addFiles([new File(["a"], "a.pdf"), new File(["b"], "b.pdf")]));
  expect(upload).not.toHaveBeenCalled();
  expect(state.entries).toHaveLength(9);
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
