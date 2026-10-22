import { Download, File, RotateCcw, X } from "lucide-react";
import type { TCommentAttachment } from "@plane/types";
import { convertBytesToSize, getFileURL } from "@plane/utils";
import { AttachmentPreviewLink } from "@/components/attachments/preview";
import type { TCommentAttachmentDraft } from "./use-comment-attachments";

/** 在评论正文下方呈现上传状态及保存后的文件下载入口。 */
export function CommentAttachmentList(props: {
  entries?: TCommentAttachmentDraft[];
  attachments?: TCommentAttachment[];
  disabled?: boolean;
  error?: string;
  onRemove?: (key: string) => void;
  onRetry?: (key: string) => void;
}) {
  const { disabled, error, onRemove, onRetry } = props;
  const entries =
    props.entries ??
    props.attachments?.map((attachment) => ({
      key: attachment.id,
      name: attachment.name,
      size: attachment.size,
      attachment,
      status: "ready" as const,
    })) ??
    [];
  if (!entries.length && !error) return null;
  return (
    <div className="mt-2 min-w-0 text-12 text-secondary">
      {error && (
        <p role="alert" className="mb-2 text-danger-primary">
          {error}
        </p>
      )}
      <ul aria-label="评论附件" className="divide-y divide-subtle border-t border-subtle">
        {entries.map((entry) => (
          <li key={entry.key} className="flex min-w-0 items-center gap-2 py-2">
            <File aria-hidden className="size-4 shrink-0 text-tertiary" />
            <div className="min-w-0 flex-1 truncate text-primary">
              {entry.attachment ? (
                <AttachmentPreviewLink
                  name={entry.name}
                  previewUrl={entry.attachment.preview_url}
                  downloadUrl={entry.attachment.download_url}
                  className="max-w-full truncate text-left hover:underline"
                />
              ) : (
                <span title={entry.name}>{entry.name}</span>
              )}
            </div>
            <span className="shrink-0 text-tertiary">{convertBytesToSize(entry.size)}</span>
            {entry.status === "uploading" && <span role="status">上传中…</span>}
            {entry.status === "failed" && (
              <span role="alert" className="text-danger-primary">
                上传失败
              </span>
            )}
            {entry.status === "failed" && onRetry && (
              <button
                type="button"
                disabled={disabled}
                aria-label={`重试 ${entry.name}`}
                title="重试上传"
                className="rounded p-1 hover:bg-surface-2"
                onClick={() => onRetry(entry.key)}
              >
                <RotateCcw className="size-3.5" />
              </button>
            )}
            {entry.attachment && !onRemove && (
              <a
                href={getFileURL(entry.attachment.download_url)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`下载 ${entry.name}`}
                title="下载附件"
                className="rounded p-1 hover:bg-surface-2"
              >
                <Download className="size-3.5" />
              </a>
            )}
            {onRemove && (
              <button
                type="button"
                disabled={disabled}
                aria-label={`移除 ${entry.name}`}
                title="移除附件"
                className="rounded p-1 hover:bg-surface-2"
                onClick={() => onRemove(entry.key)}
              >
                <X className="size-3.5" />
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
