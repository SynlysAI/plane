// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }));

vi.mock("pdfjs-dist", () => ({
  getDocument,
  GlobalWorkerOptions: { workerSrc: "" },
}));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/pdf.worker.js" }));

const PdfReader = (await import("@/components/attachments/preview-pdf")).default;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}

/** 构造 PDF.js 页面对象，记录渲染任务以便断言翻页行为。 */
function createPage() {
  const renderTask = { promise: Promise.resolve(), cancel: vi.fn() };
  return {
    getViewport: vi.fn(({ scale }: { scale: number }) => ({ width: 600 * scale, height: 300 * scale })),
    render: vi.fn(() => renderTask),
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({}) as unknown as CanvasRenderingContext2D
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("renders the second page without resetting the reader", async () => {
  const firstPage = createPage();
  const secondPage = createPage();
  const pdfDocument = {
    numPages: 2,
    getPage: vi.fn((pageNumber: number) => (pageNumber === 1 ? firstPage : secondPage)),
  };
  const task = { promise: Promise.resolve(pdfDocument), destroy: vi.fn() };
  getDocument.mockReturnValue(task);

  await act(async () => root.render(<PdfReader url="/preview/report.pdf" />));
  await act(async () => Promise.resolve());

  expect(document.querySelector("canvas")?.getAttribute("aria-label")).toBe("PDF 第 1 页");

  const nextPage = [...document.querySelectorAll("button")].find((button) => button.textContent === "下一页");
  if (!nextPage) throw new Error("下一页按钮未显示");
  await act(async () => {
    nextPage.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    nextPage.click();
  });
  await act(async () => Promise.resolve());

  expect(pdfDocument.getPage).toHaveBeenLastCalledWith(2);
  expect(secondPage.render).toHaveBeenCalledOnce();
  expect(document.querySelector("canvas")?.getAttribute("aria-label")).toBe("PDF 第 2 页");
  expect((document.querySelector('[aria-label="页码"]') as HTMLInputElement).value).toBe("2");
});
