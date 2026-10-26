// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentPreviewLink } from "@/components/attachments/preview";

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

const post = vi.fn();
const get = vi.fn();

vi.mock("axios", () => ({
  default: {
    post: (...args: unknown[]) => post(...args),
    get: (...args: unknown[]) => get(...args),
    isAxiosError: (error: unknown) => error instanceof Error && error.name === "AxiosError",
  },
}));

/** 挂载预览入口并返回其根节点。 */
async function mountPreview(previewUrl?: string | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <AttachmentPreviewLink
        name="数据.csv"
        previewUrl={previewUrl}
        downloadUrl="/download/data.csv"
        label="数据.csv"
      />
    )
  );
  return { container, root };
}

afterEach(async () => {
  vi.clearAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("attachment preview", () => {
  it("keeps download as the direct action when preview is unavailable", async () => {
    const { root } = await mountPreview(null);
    const link = document.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/download/data.csv");
    expect(document.querySelector("button")).toBeNull();
    await act(async () => root.unmount());
  });

  it("opens a dialog and renders paginated table content", async () => {
    post.mockResolvedValueOnce({
      data: { status: "ready", kind: "table", content_url: "/preview/content/" },
    });
    get.mockResolvedValueOnce({
      data: {
        rows: [
          ["项目", "数值"],
          ["样本", "12"],
        ],
      },
    });
    const { root } = await mountPreview("/preview/");
    await act(async () => {
      document.querySelector("button")?.click();
    });
    await act(async () => Promise.resolve());
    expect(post).toHaveBeenCalledWith(
      "/preview/",
      { retry: false },
      expect.objectContaining({ withCredentials: true })
    );
    expect(get).toHaveBeenCalledWith("/preview/content/", expect.objectContaining({ withCredentials: true }));
    expect(document.body.textContent).toContain("样本");
    expect(document.body.textContent).toContain("共 2 行");
    await act(async () => root.unmount());
  });

  it("keeps the dialog open when an outer overlay handles preview mousedown", async () => {
    post.mockResolvedValueOnce({
      data: { status: "ready", kind: "table", content_url: "/preview/content/" },
    });
    get.mockResolvedValueOnce({
      data: {
        rows: Array.from({ length: 101 }, (_, index) => [`项目 ${index + 1}`, `${index + 1}`]),
      },
    });
    const outerOverlayClose = vi.fn();
    const handleOuterMousedown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-prevent-outside-click]")) return;
      outerOverlayClose();
    };
    document.addEventListener("mousedown", handleOuterMousedown);
    const { root } = await mountPreview("/preview/");
    try {
      await act(async () => {
        document.querySelector("button")?.click();
      });
      await act(async () => Promise.resolve());
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.closest("[data-prevent-outside-click]")).not.toBeNull();
      const nextPage = [...document.querySelectorAll("button")].find((button) => button.textContent === "下一页");
      if (!nextPage) throw new Error("下一页按钮未显示");
      await act(async () => {
        nextPage.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        nextPage.click();
      });
      expect(outerOverlayClose).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
      expect(document.body.textContent).toContain("2 / 2");
    } finally {
      document.removeEventListener("mousedown", handleOuterMousedown);
      await act(async () => root.unmount());
    }
  });

  it("cancels status polling when the dialog closes", async () => {
    vi.useFakeTimers();
    post.mockResolvedValueOnce({ data: { status: "processing", kind: "pdf" } });
    const { root } = await mountPreview("/preview/");
    await act(async () => {
      document.querySelector("button")?.click();
    });
    expect(document.body.textContent).toContain("正在准备预览");
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.getAttribute("aria-label") === "关闭预览")
        ?.click();
    });
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(get).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
