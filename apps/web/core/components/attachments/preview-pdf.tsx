import { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
// oxlint-disable-next-line import/default -- Vite 的 ?url 导入在构建时提供地址。
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;
const BUTTON = "rounded px-2 py-1 hover:bg-surface-2 disabled:opacity-40";

/** 使用同源 PDF.js 与字体资源逐页绘制，取消旧页任务以避免切页竞争。 */
export default function PdfReader({ url }: { url: string }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState<number | null>(null);
  const [width, setWidth] = useState(600);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const canvas = useRef<HTMLCanvasElement>(null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const task = getDocument({
      url,
      withCredentials: true,
      cMapUrl: "/pdfjs/cmaps/",
      cMapPacked: true,
      standardFontDataUrl: "/pdfjs/standard_fonts/",
      wasmUrl: "/pdfjs/wasm/",
    });
    let cancelled = false;
    void (async () => {
      try {
        const document = await task.promise;
        if (!cancelled) setPdf(document);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [url]);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => setWidth(Math.max(200, entries[0].contentRect.width - 32)));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let cancelled = false;
    let render: RenderTask | undefined;
    setLoading(true);
    void (async () => {
      try {
        const documentPage = await pdf.getPage(page);
        if (cancelled || !canvas.current) return;
        const scale = zoom ?? width / documentPage.getViewport({ scale: 1 }).width;
        const viewport = documentPage.getViewport({ scale });
        const ratio = window.devicePixelRatio || 1;
        const element = canvas.current;
        element.width = Math.floor(viewport.width * ratio);
        element.height = Math.floor(viewport.height * ratio);
        element.style.width = `${viewport.width}px`;
        element.style.height = `${viewport.height}px`;
        render = documentPage.render({
          canvas: element,
          canvasContext: element.getContext("2d")!,
          viewport,
          transform: [ratio, 0, 0, ratio, 0, 0],
        });
        await render.promise;
        if (!cancelled) setLoading(false);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
      render?.cancel();
    };
  }, [pdf, page, zoom, width]);
  if (error)
    return (
      <p role="alert" className="m-auto p-6 text-13">
        PDF 无法读取或权限已变更，请关闭后重试或下载原文件。
      </p>
    );
  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-b border-subtle bg-surface-1 p-2 text-13">
        <button className={BUTTON} disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>
          上一页
        </button>
        <label>
          页码{" "}
          <input
            aria-label="页码"
            className="w-14 rounded border border-subtle bg-surface-1 px-1"
            type="number"
            min={1}
            max={pdf?.numPages ?? 1}
            value={page}
            onChange={(event) => setPage(Math.max(1, Math.min(pdf?.numPages ?? 1, Number(event.target.value) || 1)))}
          />
        </label>
        <span>/ {pdf?.numPages ?? "…"}</span>
        <button className={BUTTON} disabled={!pdf || page >= pdf.numPages} onClick={() => setPage((v) => v + 1)}>
          下一页
        </button>
        <button className={BUTTON} onClick={() => setZoom((v) => Math.max(0.25, (v ?? 1) - 0.25))}>
          缩小
        </button>
        <button className={BUTTON} onClick={() => setZoom((v) => Math.min(3, (v ?? 1) + 0.25))}>
          放大
        </button>
        <button className={BUTTON} onClick={() => setZoom(null)}>
          适应宽度
        </button>
      </div>
      <div ref={container} className="min-h-0 flex-1 overflow-auto p-4">
        {loading && (
          <p role="status" className="text-center text-12 text-secondary">
            正在加载页面…
          </p>
        )}
        <canvas ref={canvas} className="mx-auto" aria-label={`PDF 第 ${page} 页`} />
      </div>
    </>
  );
}
