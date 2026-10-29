"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileOutline, RefreshOutline } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
import { MAX_FILE_ATTACHMENTS } from "@plane/constants";
import type { EditorRefApi } from "@plane/editor";
import type {
  TCommentAttachmentLimits,
  TResearchChainNodeTask,
  TResearchTaskInstructionAttachment,
} from "@plane/types";
import { convertBytesToSize, getFileURL, isDescriptionContentEmpty } from "@plane/utils";
import { EditorFileUploadButton } from "@/components/editor/editor-file-upload-button";
import { RichTextEditor } from "@/components/editor/rich-text";
import { getCommentAttachmentLimitError } from "@/components/comments/comment-attachment-limits";
import { taskImageDownloadSource } from "@/components/research/common/research-image";
import { ResearchChainTaskService } from "@/services/research/chain-task.service";

type Props = {
  task: TResearchChainNodeTask;
  workspaceSlug: string;
  value: string;
  editable: boolean;
  onChange: (value: string) => void;
  onAttachmentsChange: (attachments: TResearchTaskInstructionAttachment[]) => void;
  onBusyChange: (busy: boolean) => void;
};

type TAttachmentDraft = {
  key: string;
  name: string;
  size: number;
  file?: File;
  attachment?: TResearchTaskInstructionAttachment;
  status: "uploading" | "ready" | "failed";
};

const DEFAULT_IMAGE_LIMIT = 20 * 1024 * 1024;

/** Convert legacy plain-text instructions to editor-compatible HTML. */
function toEditorHtml(value: string) {
  if (!value || /<\/?[a-z][^>]*>/i.test(value)) return value || "<p></p>";
  return `<p>${value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")}</p>`;
}

/** Extract an asset id from one task-scoped image URL. */
function assetIdFromSource(source: string, imageBase: string) {
  return source.startsWith(imageBase) ? source.slice(imageBase.length).replace(/\/$/, "") : "";
}

/** Render one research task description with inline images and persisted files. */
export function ResearchTaskDescription({
  task,
  workspaceSlug,
  value,
  editable,
  onChange,
  onAttachmentsChange,
  onBusyChange,
}: Props) {
  const { t } = useTranslation();
  const service = useMemo(() => new ResearchChainTaskService(), []);
  const editorRef = useRef<EditorRefApi>(null);
  const mountedRef = useRef(true);
  const entriesRef = useRef<TAttachmentDraft[]>([]);
  const loadedTaskIdRef = useRef<string | null>(null);
  const [entries, setEntries] = useState<TAttachmentDraft[]>([]);
  const [limits, setLimits] = useState<TCommentAttachmentLimits | null>(null);
  const [attachmentError, setAttachmentError] = useState("");
  const [imageError, setImageError] = useState("");
  const [imageUploadCount, setImageUploadCount] = useState(0);
  const [attachmentUploadCount, setAttachmentUploadCount] = useState(0);
  const imageBase = `/api/research/workspaces/${workspaceSlug}/chains/${task.chain}/nodes/${task.node}/tasks/${task.id}/instruction-images/`;
  const showPlaceholder = !editable && isDescriptionContentEmpty(value);

  const updateEntries = useCallback(
    (next: TAttachmentDraft[]) => {
      entriesRef.current = next;
      if (!mountedRef.current) return;
      setEntries(next);
      onAttachmentsChange(next.flatMap((entry) => (entry.attachment ? [entry.attachment] : [])));
    },
    [onAttachmentsChange]
  );

  useEffect(() => {
    mountedRef.current = true;
    const isTaskSwitch = loadedTaskIdRef.current !== task.id;
    loadedTaskIdRef.current = task.id;
    // 父组件会回写已确认附件列表；同一任务仍有上传中或失败草稿时不能重建，
    // 否则确认结果会因为本地 key 被清空而被误删。
    if (!isTaskSwitch && entriesRef.current.some((entry) => entry.status !== "ready")) return;

    const initial = (task.instruction_attachments ?? []).map((attachment) => ({
      key: attachment.id,
      name: attachment.name,
      size: attachment.size,
      attachment,
      status: "ready" as const,
    }));
    entriesRef.current = initial;
    setEntries(initial);
    if (isTaskSwitch) {
      setImageError("");
      setAttachmentError("");
    }
    return () => {
      mountedRef.current = false;
    };
  }, [task.id, task.instruction_attachments]);

  useEffect(() => {
    if (!editable) return;
    let active = true;
    service
      .getTaskCommentAttachmentLimits(workspaceSlug, task.chain, task.node, task.id)
      .then((payload) => {
        if (active) setLimits(payload);
        return undefined;
      })
      .catch(() => {
        if (active) setAttachmentError(t("research.chain_tasks.attachment_limits_failed"));
      });
    return () => {
      active = false;
    };
  }, [editable, service, t, task.chain, task.id, task.node, workspaceSlug]);

  useEffect(() => {
    onBusyChange(imageUploadCount > 0 || attachmentUploadCount > 0);
  }, [attachmentUploadCount, imageUploadCount, onBusyChange]);

  const uploadImage = useCallback(
    async (_blockId: string, file: File) => {
      setImageUploadCount((count) => count + 1);
      try {
        const source = await service.uploadTaskInstructionImage(workspaceSlug, task.chain, task.node, task.id, file);
        setImageError("");
        return source;
      } catch (failure) {
        setImageError(failure instanceof Error ? failure.message : t("research.chain_tasks.image_upload_failed"));
        throw failure;
      } finally {
        setImageUploadCount((count) => count - 1);
      }
    },
    [service, t, task.chain, task.id, task.node, workspaceSlug]
  );

  const uploadAttachment = useCallback(
    async (entry: TAttachmentDraft) => {
      if (!entry.file) return;
      setAttachmentUploadCount((count) => count + 1);
      try {
        const attachment = await service.uploadTaskInstructionAttachment(
          workspaceSlug,
          task.chain,
          task.node,
          task.id,
          entry.file
        );
        if (!mountedRef.current || !entriesRef.current.some((item) => item.key === entry.key)) {
          await service
            .deleteTaskInstructionAttachment(workspaceSlug, task.chain, task.node, task.id, attachment.id)
            .catch(() => undefined);
          return;
        }
        updateEntries(
          entriesRef.current.map((item) => (item.key === entry.key ? { ...item, attachment, status: "ready" } : item))
        );
      } catch {
        if (mountedRef.current) {
          updateEntries(
            entriesRef.current.map((item) => (item.key === entry.key ? { ...item, status: "failed" } : item))
          );
        }
      } finally {
        setAttachmentUploadCount((count) => count - 1);
      }
    },
    [service, task.chain, task.id, task.node, updateEntries, workspaceSlug]
  );

  const addFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) {
        setAttachmentError(t("attachment.upload_zone.empty"));
        return;
      }
      if (!limits) {
        setAttachmentError(t("research.chain_tasks.attachment_limits_failed"));
        return;
      }
      if (entriesRef.current.length + files.length > MAX_FILE_ATTACHMENTS) {
        setAttachmentError(t("research.chain_tasks.attachment_count_exceeded", { count: MAX_FILE_ATTACHMENTS }));
        return;
      }
      const sizeError = files.map((file) => getCommentAttachmentLimitError(limits, file)).find(Boolean);
      if (sizeError) {
        setAttachmentError(sizeError);
        return;
      }
      setAttachmentError("");
      const added = files.map((file, index) => ({
        key: `${Date.now()}-${index}-${file.name}`,
        name: file.name,
        size: file.size,
        file,
        status: "uploading" as const,
      }));
      updateEntries([...entriesRef.current, ...added]);
      added.forEach((entry) => void uploadAttachment(entry));
    },
    [limits, t, updateEntries, uploadAttachment]
  );

  const removeAttachment = useCallback(
    async (entry: TAttachmentDraft) => {
      if (!entry.attachment) {
        updateEntries(entriesRef.current.filter((item) => item.key !== entry.key));
        return;
      }
      try {
        await service.deleteTaskInstructionAttachment(
          workspaceSlug,
          task.chain,
          task.node,
          task.id,
          entry.attachment.id
        );
        updateEntries(entriesRef.current.filter((item) => item.key !== entry.key));
      } catch {
        setAttachmentError(t("research.chain_tasks.attachment_delete_failed"));
      }
    },
    [service, t, task.chain, task.id, task.node, updateEntries, workspaceSlug]
  );

  return (
    <div className="space-y-3">
      <div className="relative">
        <RichTextEditor
          key={`${task.id}:${editable}`}
          ref={editorRef}
          id={`research-task-instruction-${task.id}`}
          containerClassName="-ml-3 border-none !p-0 pl-3!"
          initialValue={toEditorHtml(value)}
          editable={editable}
          workspaceId={task.workspace}
          workspaceSlug={workspaceSlug}
          disabledExtensions={["issue-embed"]}
          placeholder={() => t("research.chain_tasks.add_instruction")}
          searchMentionCallback={async () => ({})}
          uploadFile={uploadImage}
          duplicateFile={async () => {
            throw new Error(t("research.chain_tasks.image_reupload_required"));
          }}
          fileHandlerOverrides={{
            getAssetSrc: async (source) => source,
            getAssetDownloadSrc: async (source) => taskImageDownloadSource(source, imageBase),
            delete: async (source) => {
              const assetId = assetIdFromSource(source, imageBase);
              if (!assetId) return;
              await service.deleteTaskInstructionImage(workspaceSlug, task.chain, task.node, task.id, assetId);
            },
            restore: async (source) => {
              const assetId = assetIdFromSource(source, imageBase);
              if (!assetId) return;
              await service.restoreTaskInstructionImage(workspaceSlug, task.chain, task.node, task.id, assetId);
            },
            validation: { maxFileSize: limits?.image.max_bytes ?? DEFAULT_IMAGE_LIMIT },
          }}
          onAttachFiles={addFiles}
          onChange={(_json, html) => onChange(html)}
        />
        {editable && (
          <div className="flex justify-end">
            <EditorFileUploadButton
              editorRef={editorRef}
              onAttachFiles={addFiles}
              disabled={!limits || attachmentUploadCount > 0}
            />
          </div>
        )}
        {showPlaceholder && (
          <p className="pointer-events-none absolute top-0 left-3 text-13 text-placeholder">
            {t("research.chain_tasks.instruction_empty")}
          </p>
        )}
      </div>
      {imageError && (
        <p role="alert" className="text-12 text-danger-primary">
          {imageError}
        </p>
      )}

      {(entries.length > 0 || attachmentError) && (
        <section aria-label={t("research.chain_tasks.attachments_title")} className="space-y-2">
          {attachmentError && (
            <p role="alert" className="text-12 text-danger-primary">
              {attachmentError}
            </p>
          )}
          {entries.length ? (
            <ul className="divide-y divide-subtle border-t border-subtle text-12">
              {entries.map((entry) => (
                <li key={entry.key} className="flex min-h-9 items-center gap-2 py-2">
                  <FileOutline className="size-4 shrink-0 text-tertiary" aria-hidden />
                  <div className="min-w-0 flex-1">
                    {entry.attachment ? (
                      <a
                        href={getFileURL(entry.attachment.download_url)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block truncate text-primary hover:underline"
                      >
                        {entry.name}
                      </a>
                    ) : (
                      <span className="block truncate text-primary" title={entry.name}>
                        {entry.name}
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-tertiary">{convertBytesToSize(entry.size)}</span>
                  {entry.status === "uploading" && (
                    <span role="status" className="shrink-0 text-secondary">
                      {t("research.chain_tasks.uploading")}
                    </span>
                  )}
                  {entry.status === "failed" && (
                    <>
                      <span role="alert" className="shrink-0 text-danger-primary">
                        {t("research.chain_tasks.upload_failed")}
                      </span>
                      <button
                        type="button"
                        className="rounded p-1 text-tertiary hover:bg-surface-2 hover:text-secondary"
                        aria-label={t("research.chain_tasks.retry_upload")}
                        onClick={() => void uploadAttachment(entry)}
                      >
                        <RefreshOutline className="size-3.5" aria-hidden />
                      </button>
                    </>
                  )}
                  {editable && entry.status !== "uploading" && (
                    <button
                      type="button"
                      className="rounded px-1 text-tertiary hover:bg-surface-2 hover:text-secondary"
                      onClick={() => void removeAttachment(entry)}
                    >
                      {t("common.remove")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      )}
    </div>
  );
}
