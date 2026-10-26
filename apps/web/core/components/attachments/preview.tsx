import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogPanel, DialogTitle } from "@headlessui/react";
import axios, { isAxiosError } from "axios";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download, X } from "lucide-react";
import { getFileURL } from "@plane/utils";

const PdfReader = lazy(() => import("./preview-pdf"));
type PreviewState = {
  status: "pending" | "processing" | "ready" | "failed" | "unsupported";
  kind: "pdf" | "image" | "text" | "markdown" | "table";
  content_url?: string;
  error_code?: string;
  retryable?: boolean;
};
type Props = {
  name: string;
  previewUrl?: string | null;
  downloadUrl: string;
  label?: string;
  className?: string;
  children?: ReactNode;
};
const ERRORS: Record<string, string> = {
  preview_disabled: "预览服务暂未启用，请下载原文件。",
  invalid_file: "文件格式不匹配或内容损坏，无法预览。",
  encrypted_file: "加密文件暂不支持预览，请下载后打开。",
  file_too_large: "文件超出预览处理范围，请下载原文件。",
  source_missing: "原文件已不存在或暂时无法读取。",
  source_changed: "文件内容已变化，请关闭后重新打开。",
  timeout: "预览转换超时，请重试。",
};
const BUTTON = "rounded px-2 py-1 text-13 hover:bg-surface-2 disabled:opacity-40";

/** 文件名触发统一预览；没有预览能力时保留原下载行为。 */
export function AttachmentPreviewLink({ name, previewUrl, downloadUrl, label, className, children }: Props) {
  const [open, setOpen] = useState(false);
  if (!previewUrl) {
    return (
      <a className={className} href={getFileURL(downloadUrl)} onClick={(event) => event.stopPropagation()}>
        {children ?? label ?? name}
      </a>
    );
  }
  return (
    <>
      <button
        type="button"
        className={className}
        title={name}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        {children ?? label ?? name}
      </button>
      {open && (
        <AttachmentPreviewDialog
          name={name}
          previewUrl={previewUrl}
          downloadUrl={downloadUrl}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** 对话框存在期间加载预览，关闭时取消请求及状态轮询。 */
export function AttachmentPreviewDialog({ name, previewUrl, downloadUrl, onClose }: Props & { onClose: () => void }) {
  const [state, setState] = useState<PreviewState>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    setState(undefined);
    setError("");
    /** 发起转换后仅查询状态，最多等待五分钟，避免无限轮询。 */
    async function load(create: boolean) {
      try {
        const url = getFileURL(previewUrl ?? "");
        if (!url) throw new Error("Missing preview URL");
        const config = { signal: controller.signal, withCredentials: true };
        const response = create ? await axios.post(url, { retry: attempt > 0 }, config) : await axios.get(url, config);
        if (controller.signal.aborted) return;
        const next = response.data as PreviewState;
        setState(next);
        if (next.status === "pending" || next.status === "processing") {
          if (Date.now() - started > 300_000) {
            setState({ ...next, status: "failed", error_code: "timeout", retryable: true });
          } else timer = setTimeout(() => void load(false), 1500);
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (isAxiosError(failure) && failure.response?.data?.error_code) {
          setState(failure.response.data as PreviewState);
        } else {
          setError(
            isAxiosError(failure) && [401, 403, 404].includes(failure.response?.status ?? 0)
              ? "文件已移除或你没有查看权限。"
              : "暂时无法读取预览，请稍后重试。"
          );
        }
      }
    }
    void load(true);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [previewUrl, attempt]);
  return (
    <Dialog open onClose={onClose} className="relative z-[100]" data-prevent-outside-click="true">
      <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center sm:p-6">
        <DialogPanel className="flex h-full w-full flex-col overflow-hidden bg-surface-1 text-primary sm:h-[90vh] sm:max-w-6xl sm:rounded-lg">
          <header className="flex shrink-0 items-center gap-3 border-b border-subtle px-4 py-3">
            <DialogTitle className="min-w-0 flex-1 truncate text-14 font-medium" title={name}>
              {name}
            </DialogTitle>
            <a href={getFileURL(downloadUrl)} className={BUTTON} aria-label="下载原文件">
              <Download className="mr-1 inline size-4" />
              下载原文件
            </a>
            <button type="button" className={BUTTON} onClick={onClose} aria-label="关闭预览">
              <X className="size-4" />
            </button>
          </header>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto bg-surface-2">
            {error ? (
              <div role="alert" className="m-auto p-6 text-13">
                {error}
                <button type="button" className={BUTTON} onClick={() => setAttempt((value) => value + 1)}>
                  重试
                </button>
              </div>
            ) : state?.status === "ready" && state.content_url ? (
              <PreviewContent key={state.content_url + attempt} kind={state.kind} url={state.content_url} name={name} />
            ) : (
              <div className="m-auto p-6 text-center text-13 text-secondary" role="status">
                {state?.status === "unsupported"
                  ? "此文件类型暂不支持预览，请下载原文件。"
                  : state?.status === "failed"
                    ? (ERRORS[state.error_code ?? ""] ?? "预览生成失败，请重试或下载原文件。")
                    : "正在准备预览…"}
                {state?.retryable && (
                  <button type="button" className={BUTTON} onClick={() => setAttempt((value) => value + 1)}>
                    重试
                  </button>
                )}
              </div>
            )}
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

/** 根据服务端验证过的类型加载内容，不将上传文件作为 HTML 执行。 */
function PreviewContent({ kind, url, name }: { kind: PreviewState["kind"]; url: string; name: string }) {
  const [data, setData] = useState<{ text?: string; rows?: string[][] }>();
  const [error, setError] = useState(false);
  const [page, setPage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const objectUrl = useRef<string | undefined>(undefined);
  const [imageUrl, setImageUrl] = useState("");
  useEffect(() => {
    if (kind === "pdf") return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await axios.get(getFileURL(url)!, {
          signal: controller.signal,
          withCredentials: true,
          responseType: kind === "image" ? "blob" : "json",
        });
        if (controller.signal.aborted) return;
        if (kind === "image") {
          objectUrl.current = URL.createObjectURL(response.data);
          setImageUrl(objectUrl.current);
        } else {
          setData(response.data);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    };
  }, [kind, url]);
  if (error)
    return (
      <p role="alert" className="m-auto p-6">
        无法读取预览，请关闭后重试或下载原文件。
      </p>
    );
  if (kind === "pdf")
    return (
      <Suspense
        fallback={
          <p role="status" className="m-auto">
            正在加载阅读器…
          </p>
        }
      >
        <PdfReader url={getFileURL(url)!} />
      </Suspense>
    );
  if (kind === "image")
    return (
      <>
        <div className="flex justify-center gap-2 p-2">
          <button type="button" className={BUTTON} onClick={() => setZoom((v) => Math.max(0.25, v - 0.25))}>
            缩小
          </button>
          <span className="p-1 text-13">{Math.round(zoom * 100)}%</span>
          <button type="button" className={BUTTON} onClick={() => setZoom((v) => Math.min(4, v + 0.25))}>
            放大
          </button>
          <button type="button" className={BUTTON} onClick={() => setZoom(1)}>
            适应宽度
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={name}
              className="mx-auto h-auto"
              style={{ width: `${zoom * 100}%`, maxWidth: "none" }}
              onError={() => setError(true)}
            />
          ) : (
            <p role="status">正在加载图片…</p>
          )}
        </div>
      </>
    );
  if (!data)
    return (
      <p role="status" className="m-auto">
        正在加载内容…
      </p>
    );
  if (kind === "table") {
    const rows = data.rows ?? [];
    const count = Math.max(1, Math.ceil(rows.length / 100));
    return (
      <>
        <div className="flex items-center justify-center gap-3 p-2 text-13">
          <button type="button" className={BUTTON} disabled={!page} onClick={() => setPage((v) => v - 1)}>
            上一页
          </button>
          <span>
            {page + 1} / {count} · 共 {rows.length} 行
          </span>
          <button type="button" className={BUTTON} disabled={page + 1 >= count} onClick={() => setPage((v) => v + 1)}>
            下一页
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-surface-1">
          <table className="w-full border-collapse text-13">
            <tbody>
              {rows.slice(page * 100, (page + 1) * 100).map((row, index) => (
                // CSV 允许重复行，行号是只读分页下的稳定标识。
                // oxlint-disable-next-line react/no-array-index-key
                <tr key={index} className="border-b border-subtle">
                  <th className="px-3 py-2 text-tertiary">{page * 100 + index + 1}</th>
                  {row.map((cell, col) => (
                    // oxlint-disable-next-line react/no-array-index-key
                    <td key={col} className="max-w-xl px-3 py-2 align-top break-words whitespace-pre-wrap">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }
  if (kind === "markdown")
    return (
      <article className="prose-sm mx-auto w-full max-w-4xl bg-surface-1 p-6 text-primary prose">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          components={{
            img: ({ alt }) => <span className="text-tertiary">[图片：{alt || "已禁用外部加载"}]</span>,
            a: ({ children }) => <span>{children}</span>,
          }}
        >
          {data.text ?? ""}
        </ReactMarkdown>
      </article>
    );
  return <pre className="m-4 bg-surface-1 p-4 text-13 break-words whitespace-pre-wrap">{data.text}</pre>;
}
