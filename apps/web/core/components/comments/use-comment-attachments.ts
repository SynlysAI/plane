import { useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import { useTranslation } from "@plane/i18n";
import { MAX_FILE_ATTACHMENTS } from "@plane/constants";
import type { TCommentAttachment, TCommentAttachmentLimits } from "@plane/types";
import { getCommentAttachmentLimitError } from "./comment-attachment-limits";

export type TCommentAttachmentDraft = {
  key: string;
  name: string;
  size: number;
  file?: File;
  attachment?: TCommentAttachment;
  status: "uploading" | "ready" | "failed";
};

type TCommentAttachmentOperations = {
  uploadCommentAttachment?: (file: File) => Promise<TCommentAttachment>;
  discardCommentAttachment?: (assetId: string) => Promise<void>;
};

/** 管理评论文件草稿，保存前不删除已发布文件，及时清理被移除的临时上传。
 *
 * @param operations 评论上传与废弃操作。
 * @param limits 项目级四类附件额度；尚未加载时为 null。
 * @param initial 编辑评论时已有的附件。
 * @returns 草稿列表、校验错误、上传队列及保存生命周期操作。
 */
export function useCommentAttachments(
  operations: TCommentAttachmentOperations,
  limits: TCommentAttachmentLimits | null,
  initial: TCommentAttachment[] = []
) {
  const { t } = useTranslation();
  const original = useRef<TCommentAttachmentDraft[]>(
    initial.map((attachment) => ({
      key: attachment.id,
      name: attachment.name,
      size: attachment.size,
      attachment,
      status: "ready",
    }))
  );
  const [entries, setEntries] = useState(original.current);
  const [error, setError] = useState("");
  const entriesRef = useRef(entries);
  const operationsRef = useRef(operations);
  const mounted = useRef(true);
  operationsRef.current = operations;

  /** 同步草稿引用，避免连续选择、移除及迟到上传之间产生竞争。 */
  function update(next: TCommentAttachmentDraft[]) {
    entriesRef.current = next;
    if (mounted.current) setEntries(next);
  }

  /** 草稿清理失败时交由服务端过期回收，不影响已保存评论。 */
  async function discard(id: string) {
    try {
      await operationsRef.current.discardCommentAttachment?.(id);
    } catch {
      /* 临时文件由定时清理任务回收。 */
    }
  }

  /** 上传完成后仅更新仍在当前草稿中的条目。 */
  async function upload(entry: TCommentAttachmentDraft) {
    try {
      if (!entry.file || !operationsRef.current.uploadCommentAttachment) return;
      const attachment = await operationsRef.current.uploadCommentAttachment(entry.file);
      if (!mounted.current || !entriesRef.current.some((item) => item.key === entry.key)) {
        await discard(attachment.id);
        return;
      }
      update(
        entriesRef.current.map((item) => (item.key === entry.key ? { ...item, attachment, status: "ready" } : item))
      );
    } catch {
      update(entriesRef.current.map((item) => (item.key === entry.key ? { ...item, status: "failed" } : item)));
    }
  }

  /** 批次校验数量和大小，通过后并行上传且分别保留结果。 */
  function addFiles(files: File[]) {
    if (files.length === 0) {
      setError(t("attachment.upload_zone.empty"));
      return;
    }
    if (!limits) {
      setError(t("comment.attachment_limits_failed"));
      return;
    }
    if (entriesRef.current.length + files.length > MAX_FILE_ATTACHMENTS) {
      setError(t("comment.attachment_count_limit", { count: MAX_FILE_ATTACHMENTS }));
      return;
    }
    const sizeError = files.map((file) => getCommentAttachmentLimitError(limits, file)).find(Boolean);
    if (sizeError) {
      setError(sizeError);
      return;
    }
    setError("");
    const added: TCommentAttachmentDraft[] = files.map((file) => ({
      key: uuidv4(),
      name: file.name,
      size: file.size,
      file,
      status: "uploading",
    }));
    update([...entriesRef.current, ...added]);
    added.forEach((entry) => {
      void upload(entry);
    });
  }

  /** 重试单个失败文件，保持其他文件不变。 */
  async function retry(key: string) {
    const entry = entriesRef.current.find((item) => item.key === key && item.status === "failed");
    if (!entry) return;
    update(entriesRef.current.map((item) => (item.key === key ? { ...item, status: "uploading" } : item)));
    await upload(entry);
  }

  /** 从本地列表移除文件；已发布文件在保存前保持可用。 */
  async function remove(key: string) {
    const entry = entriesRef.current.find((item) => item.key === key);
    update(entriesRef.current.filter((item) => item.key !== key));
    setError("");
    if (entry?.attachment && !original.current.some((item) => item.key === key)) await discard(entry.attachment.id);
  }

  /** 取消编辑，只清理新增上传并恢复原附件列表。 */
  async function cancel() {
    const added = entriesRef.current.filter((entry) => !original.current.some((item) => item.key === entry.key));
    update(original.current);
    setError("");
    await Promise.all(added.map((entry) => (entry.attachment ? discard(entry.attachment.id) : Promise.resolve())));
  }

  /** 保存成功后解除草稿清理责任，文件已归属评论。 */
  function commit() {
    original.current = [];
    update([]);
    setError("");
  }

  /** 评论已落库后保留列表供关联重试，并停止将已保存文件视为临时文件。 */
  function markSaved() {
    original.current = entriesRef.current;
  }

  useEffect(() => {
    if (limits) setError("");
  }, [limits]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      entriesRef.current.forEach((entry) => {
        if (entry.attachment && !original.current.some((item) => item.key === entry.key)) {
          void discard(entry.attachment.id);
        }
      });
    };
  }, []);

  return {
    entries,
    error,
    addFiles,
    retry,
    remove,
    cancel,
    commit,
    markSaved,
    isBlocked: entries.some((entry) => entry.status !== "ready"),
    attachmentIds: entries.flatMap((entry) => (entry.attachment ? [entry.attachment.id] : [])),
  };
}
