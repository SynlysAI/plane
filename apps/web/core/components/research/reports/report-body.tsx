import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { EditorRefApi, TEditorCommentAnchor, TEditorSelectionAnchor, TFileHandler } from "@plane/editor";
import type { JSONContent, TPeriodicReport } from "@plane/types";
import { Button } from "@plane/propel/button";
import { ModalCore } from "@plane/ui";
import { DocumentEditor } from "@/components/editor/document/editor";
import { templateSectionStats } from "@/components/research/common/template-section-stats";
import { useResearch } from "@/hooks/store/use-research";

export type ReportBodyRef = {
  focusComment: (threadId: string) => boolean;
  save: () => Promise<boolean>;
};
type Props = {
  report: TPeriodicReport;
  workspaceSlug: string;
  workspaceId: string;
  onBusy: (busy: boolean) => void;
  commentAnchors?: TEditorCommentAnchor[];
  activeThreadId?: string | null;
  onCreateComment?: (anchor: TEditorSelectionAnchor) => void;
  onCommentAnchorClick?: (threadId: string) => void;
};

const EMPTY_COMMENT_ANCHORS: TEditorCommentAnchor[] = [];

/** 在报告详情统一编辑正文，保存失败和后台刷新均保留本地修改。 */
export const ReportBody = forwardRef<ReportBodyRef, Props>(function ReportBody(
  {
    report,
    workspaceSlug,
    workspaceId,
    onBusy,
    commentAnchors = EMPTY_COMMENT_ANCHORS,
    activeThreadId = null,
    onCreateComment,
    onCommentAnchorClick,
  },
  ref
) {
  const research = useResearch();
  const editor = useRef<EditorRefApi>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const markdownInput = useRef<HTMLInputElement>(null);
  const dirtyRef = useRef(false);
  const revision = useRef(0);
  const uploads = useRef(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadCount, setUploadCount] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  const [error, setError] = useState("");
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [selectionAnchor, setSelectionAnchor] = useState<TEditorSelectionAnchor | null>(null);
  const [selectionPosition, setSelectionPosition] = useState<{ left: number; top: number } | null>(null);
  const [replacement, setReplacement] = useState<File | null>(null);
  const [localImages, setLocalImages] = useState<string[]>([]);
  const editable = Boolean(report.can_edit);
  const content = report.draft_content ?? report.official_content;
  const [initialContent, setInitialContent] = useState<string | JSONContent>(
    content && Object.keys(content.description_json ?? {}).length
      ? (content.description_json as JSONContent)
      : content?.description_html || "<p></p>"
  );
  const [currentDocument, setCurrentDocument] = useState<string | JSONContent>(initialContent);
  const syncedContent = useRef(JSON.stringify(initialContent));
  const imageBase = `/api/research/workspaces/${workspaceSlug}/reports/${report.id}/images/`;
  const sectionStats = useMemo(
    () => templateSectionStats(currentDocument, report.template_detail?.sections_json?.sections ?? []),
    [currentDocument, report.template_detail?.sections_json?.sections]
  );

  useEffect(() => {
    editor.current?.setCommentAnchors?.(commentAnchors);
  }, [activeThreadId, commentAnchors, content, editorGeneration]);

  useEffect(() => {
    if (dirtyRef.current || saving || !content) return;
    const nextContent = Object.keys(content.description_json ?? {}).length
      ? (content.description_json as JSONContent)
      : content.description_html || "<p></p>";
    const serialized = JSON.stringify(nextContent);
    if (serialized === syncedContent.current) return;
    syncedContent.current = serialized;
    setInitialContent(nextContent);
    setCurrentDocument(nextContent);
    // DocumentEditor consumes value only on mount, so reload pristine server content explicitly.
    setEditorGeneration((value) => value + 1);
  }, [content, saving]);

  useEffect(() => {
    onBusy(!content || saving || uploadCount > 0);
  }, [content, saving, uploadCount, onBusy]);

  /** 先完成图片直传与实际校验，再把资源插入正文。 */
  const uploadImage = useCallback<TFileHandler["upload"]>(
    async (_blockId, file) => {
      uploads.current += 1;
      setUploadCount(uploads.current);
      try {
        const prepare = await fetch(imageBase, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_name: file.name, content_type: file.type, size: file.size }),
        });
        if (!prepare.ok) throw new Error("图片类型或大小不符合要求，请选择 JPEG、PNG、WebP、GIF。");
        const slot = await prepare.json();
        const form = new FormData();
        Object.entries(slot.upload_data.fields).forEach(([key, value]) => form.append(key, String(value)));
        form.append("file", file);
        const uploaded = await fetch(slot.upload_data.url, { method: "POST", body: form });
        if (!uploaded.ok) throw new Error("图片上传失败，请重试。");
        const registered = await fetch(`${imageBase}${slot.asset_id}/`, { method: "POST" });
        if (!registered.ok) throw new Error("图片文件校验失败，请重试。");
        return `${imageBase}${slot.asset_id}/`;
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "图片上传失败。");
        throw failure;
      } finally {
        uploads.current -= 1;
        setUploadCount(uploads.current);
      }
    },
    [imageBase]
  );

  /** 显式保存本地版本；保存过程中新增的编辑继续保持未保存状态。 */
  const save = useCallback(async () => {
    if (!editable) return true;
    if (!content || uploads.current > 0 || saving) return false;
    const document = editor.current?.getDocument();
    if (!document) return false;
    const savedRevision = revision.current;
    setSaving(true);
    try {
      await research.saveReportDraft(workspaceSlug, report.id, {
        description_json: document.json ?? {},
        description_html: document.html,
        description_binary: document.binary
          ? btoa(Array.from(document.binary, (byte) => String.fromCharCode(byte)).join(""))
          : "",
      });
      if (savedRevision === revision.current) {
        dirtyRef.current = false;
        setDirty(false);
      }
      setSaveFailed(false);
      setError("");
      return savedRevision === revision.current;
    } catch {
      setSaveFailed(true);
      setError("保存失败，本地内容已保留，请重新保存后提交。");
      return false;
    } finally {
      setSaving(false);
    }
  }, [content, editable, report.id, research, saving, workspaceSlug]);

  useImperativeHandle(
    ref,
    () => ({
      save,
      focusComment: (threadId: string) => editor.current?.focusCommentAnchor?.(threadId) ?? false,
    }),
    [save]
  );

  /** 同步正文选区，并把批注入口放在浏览器原生选区附近。 */
  const handleStateChange = useCallback(() => {
    const anchor = editor.current?.getSelectionAnchor?.() ?? null;
    setSelectionAnchor(anchor);
    if (!anchor || !onCreateComment) {
      setSelectionPosition(null);
      return;
    }
    const domSelection = window.getSelection();
    if (!domSelection || domSelection.rangeCount === 0) {
      setSelectionPosition(null);
      return;
    }
    const rect = domSelection.getRangeAt(0).getBoundingClientRect();
    setSelectionPosition({ left: rect.left, top: rect.top });
  }, [onCreateComment]);

  /** 导入文件后重新挂载编辑器，避免旧 JSON 或二进制状态覆盖新 HTML。 */
  const importMarkdown = useCallback(
    async (file: File) => {
      if (uploads.current > 0 || saving) return;
      try {
        const paths = await research.importReportMarkdown(workspaceSlug, report.id, {
          content: await file.text(),
          file_name: file.name,
        });
        const fresh = research.reports[report.id].draft_content;
        dirtyRef.current = false;
        setDirty(false);
        setSaveFailed(false);
        setInitialContent(fresh?.description_html || "<p></p>");
        setCurrentDocument((fresh?.description_json ?? {}) as JSONContent);
        setEditorGeneration((value) => value + 1);
        setLocalImages(paths);
        setReplacement(null);
        setError("");
      } catch {
        setError("Markdown 导入失败，本地内容已保留，请重试。");
      }
    },
    [report.id, research, saving, workspaceSlug]
  );

  /** 文件选择后插入图片，粘贴和拖放复用编辑器的同一上传回调。 */
  const insertImage = async (file: File, localPath?: string) => {
    try {
      const src = await uploadImage("report-image", file);
      editor.current?.setEditorValueAtCursorPosition(`<img src="${src}" alt="">`);
      if (localPath) setLocalImages((paths) => paths.filter((path) => path !== localPath));
    } catch {
      /* 上传函数已经显示具体错误。 */
    }
  };

  /** 导出当前编辑器内容为 Markdown 文件。 */
  const exportMarkdown = () => {
    const blob = new Blob([editor.current?.getMarkDown() ?? ""], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${report.period_key}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="border-t border-subtle pt-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-14 font-semibold text-primary">报告正文</h2>
        <div className="flex flex-wrap items-center gap-2">
          <span role="status" className="text-12 text-secondary">
            {!content
              ? "加载中"
              : saving
                ? "保存中"
                : uploadCount
                  ? "图片上传中"
                  : saveFailed
                    ? "保存失败"
                    : dirty
                      ? "未保存"
                      : editable
                        ? "已保存"
                        : `正式版本 v${report.official_content?.version_no ?? "—"}`}
          </span>
          {editable && (
            <>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => imageInput.current?.click()}
                disabled={!content || saving}
              >
                插入图片
              </Button>
              <details className="relative text-12">
                <summary className="cursor-pointer px-2 py-1">正文操作</summary>
                <div className="absolute right-0 z-10 flex min-w-32 flex-col gap-1 rounded-md border border-subtle bg-surface-1 p-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => markdownInput.current?.click()}
                    disabled={!content || saving || uploadCount > 0}
                  >
                    导入 Markdown
                  </Button>
                  <Button variant="ghost" size="sm" onClick={exportMarkdown}>
                    导出 Markdown
                  </Button>
                </div>
              </details>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void save()}
                disabled={!content || saving || uploadCount > 0}
              >
                保存
              </Button>
            </>
          )}
          {!editable && (
            <Button variant="ghost" size="sm" onClick={exportMarkdown}>
              导出 Markdown
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="mb-3 text-12 text-danger-primary">
          {error}
        </p>
      )}
      {report.template_detail?.sections_json?.sections?.length ? (
        <section className="mb-4 border border-subtle bg-surface-1 px-3 py-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-subtle pb-2">
            <h3 className="text-13 font-semibold text-primary">填写框架</h3>
            <span className="text-11 text-tertiary">字数提示仅作引导，不会阻止保存或提交</span>
          </div>
          {report.template_detail.sections_json.guidance && (
            <p className="mt-2 border-l border-subtle pl-2 text-12 leading-6 text-tertiary">
              {report.template_detail.sections_json.guidance}
            </p>
          )}
          <dl className="mt-2 grid gap-2 md:grid-cols-2">
            {sectionStats.map(({ section, count }) => {
              const missing = section.required && count === 0;
              const overLimit = Boolean(section.max_chars && count > section.max_chars);
              return (
                <div key={section.id} className="border-b border-subtle pb-2 last:border-b-0">
                  <dt className="flex items-baseline justify-between gap-2 text-12 font-medium text-primary">
                    <span>
                      {section.title}
                      {section.required ? " *" : ""}
                    </span>
                    <span className="font-normal text-11 text-tertiary">
                      {count}
                      {section.max_chars ? ` / ${section.max_chars}` : ""}
                    </span>
                  </dt>
                  <dd className="mt-1 text-11 leading-5 text-tertiary">{section.guidance}</dd>
                  {(missing || overLimit) && (
                    <dd className="mt-1 text-11 text-warning-primary">
                      {missing ? "必填章节尚未填写。" : `已超过建议字数上限 ${section.max_chars} 字。`}
                    </dd>
                  )}
                </div>
              );
            })}
          </dl>
        </section>
      ) : null}
      {localImages.map((path) => (
        <label key={path} className="mb-2 flex flex-wrap items-center gap-2 text-12 text-secondary">
          相对路径图片 {path}：请选择对应图片上传替换
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void insertImage(file, path);
            }}
          />
        </label>
      ))}
      <input
        ref={imageInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void insertImage(file);
          event.target.value = "";
        }}
      />
      <input
        ref={markdownInput}
        type="file"
        accept=".md,.markdown"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            if (dirtyRef.current) setReplacement(file);
            else void importMarkdown(file);
          }
          event.target.value = "";
        }}
      />
      {content && (
        <div
          className="relative"
          role="presentation"
          onClick={(event) => {
            const target = event.target as HTMLElement;
            const anchorElement = target.closest("[data-comment-thread-id]");
            const threadId = anchorElement?.getAttribute("data-comment-thread-id");
            if (threadId) onCommentAnchorClick?.(threadId);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            const target = event.target as HTMLElement;
            const threadId = target.closest("[data-comment-thread-id]")?.getAttribute("data-comment-thread-id");
            if (threadId) onCommentAnchorClick?.(threadId);
          }}
        >
          {selectionAnchor && selectionPosition && onCreateComment && (
            <button
              type="button"
              className="fixed z-20 rounded-md border border-subtle bg-surface-1 px-2 py-1 text-12 text-secondary hover:text-primary"
              style={{
                left: `${Math.max(selectionPosition.left - 24, 0)}px`,
                top: `${Math.max(selectionPosition.top - 36, 0)}px`,
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onCreateComment(selectionAnchor);
                setSelectionAnchor(null);
                setSelectionPosition(null);
              }}
            >
              批注选中文字
            </button>
          )}
          <DocumentEditor
            ref={editor}
            key={`${report.id}:${editorGeneration}:${editable}`}
            id={`${report.id}-body`}
            value={initialContent}
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
            containerClassName="min-h-64 border-none !p-0"
            editorClassName="pl-0"
            editable={editable}
            disabledExtensions={["issue-embed"]}
            searchMentionCallback={async () => ({})}
            uploadFile={uploadImage}
            duplicateFile={async () => {
              throw new Error("请重新选择图片上传到此报告。");
            }}
            fileHandlerOverrides={{
              getAssetSrc: async (source) =>
                source.startsWith("http") || source.startsWith(imageBase) ? source : `${imageBase}${source}/`,
              getAssetDownloadSrc: async (source) =>
                source.startsWith("http") || source.startsWith(imageBase) ? source : `${imageBase}${source}/`,
              delete: async (source) => {
                if (!source.startsWith(imageBase)) return;
                const response = await fetch(source, { method: "DELETE" });
                if (!response.ok) throw new Error("图片移除失败，请重试。");
              },
              restore: async (source) => {
                if (!source.startsWith(imageBase)) return;
                const response = await fetch(source, { method: "POST" });
                if (!response.ok) throw new Error("图片恢复失败，请重试。");
              },
              validation: { maxFileSize: (research.settings[workspaceSlug]?.image_max_mb ?? 20) * 1024 * 1024 },
            }}
            onTransaction={handleStateChange}
            onChange={(_json, _html, options) => {
              // 编辑器初始化时会补充稳定的块 ID；这类迁移更新不应把刚加载的报告标记为未保存。
              if (options?.isMigrationUpdate) return;
              setCurrentDocument(_json as JSONContent);
              revision.current += 1;
              dirtyRef.current = true;
              setDirty(true);
            }}
          />
        </div>
      )}
      <ModalCore isOpen={Boolean(replacement)} handleClose={() => setReplacement(null)}>
        <div className="bg-surface-1 p-5">
          <h3 className="text-14 font-semibold">替换未保存正文</h3>
          <p className="my-3 text-13 text-secondary">当前正文有未保存修改，导入 Markdown 将替换这些内容。</p>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={() => replacement && void importMarkdown(replacement)}>
              替换正文
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setReplacement(null)}>
              取消
            </Button>
          </div>
        </div>
      </ModalCore>
    </section>
  );
});
