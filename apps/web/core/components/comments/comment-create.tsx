/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useRef, useState } from "react";
import { observer } from "mobx-react";
import { useForm, Controller } from "react-hook-form";
// plane imports
import { EIssueCommentAccessSpecifier } from "@plane/constants";
import type { EditorRefApi } from "@plane/editor";
import type { TIssueComment, TCommentsOperations } from "@plane/types";
import { cn, isCommentEmpty } from "@plane/utils";
// components
import { LiteTextEditor } from "@/components/editor/lite-text";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";
// services
import { FileService } from "@/services/file.service";
import { useFileSize } from "@/hooks/use-file-size";
import { CommentAttachmentList } from "./attachment-list";
import { useCommentAttachments } from "./use-comment-attachments";

type TCommentCreate = {
  entityId: string;
  workspaceSlug: string;
  activityOperations: TCommentsOperations;
  showToolbarInitially?: boolean;
  projectId?: string;
  onSubmitCallback?: (elementId: string) => void;
};

// services
const fileService = new FileService();

export const CommentCreate = observer(function CommentCreate(props: TCommentCreate) {
  const {
    workspaceSlug,
    entityId,
    activityOperations,
    showToolbarInitially = false,
    projectId,
    onSubmitCallback,
  } = props;
  // states
  const uploadedAssetIds = useRef<string[]>([]);
  const [submitError, setSubmitError] = useState("");
  const savedCommentId = useRef<string | null>(null);
  const submissionLock = useRef(false);
  // refs
  const editorRef = useRef<EditorRefApi>(null);
  // store hooks
  const workspaceStore = useWorkspace();
  const { maxFileSize } = useFileSize();
  const attachmentDraft = useCommentAttachments(activityOperations, maxFileSize);
  const supportsAttachments = !!activityOperations.uploadCommentAttachment;
  // derived values
  const workspaceId = workspaceStore.getWorkspaceBySlug(workspaceSlug)?.id as string;
  // form info
  const {
    handleSubmit,
    control,
    watch,
    formState: { isSubmitting },
    reset,
  } = useForm<Partial<TIssueComment>>({
    defaultValues: {
      comment_html: "<p></p>",
    },
  });

  /** 保存成功后才清空；图片关联失败时重用已创建的评论。 */
  const onSubmit = async (formData: Partial<TIssueComment>) => {
    if (
      submissionLock.current ||
      attachmentDraft.isBlocked ||
      (isCommentEmpty(formData.comment_html) && !attachmentDraft.attachmentIds.length) ||
      !editorRef.current?.isEditorReadyToDiscard()
    )
      return;
    submissionLock.current = true;
    setSubmitError("");
    try {
      const commentHTML = editorRef.current?.getDocument().html ?? formData.comment_html ?? "<p></p>";
      const payload = {
        ...formData,
        comment_html: commentHTML,
        ...(supportsAttachments ? { attachment_ids: attachmentDraft.attachmentIds } : {}),
      };
      if (savedCommentId.current) {
        await activityOperations.updateComment(savedCommentId.current, payload);
      } else {
        const comment = await activityOperations.createComment(payload);
        if (!comment?.id) throw new Error("评论未保存");
        savedCommentId.current = comment.id;
      }
      // 文件已归属评论，后续图片关联失败或组件卸载也不应清理这些文件。
      attachmentDraft.markSaved();
      if (uploadedAssetIds.current.length > 0) {
        if (projectId) {
          await fileService.updateBulkProjectAssetsUploadStatus(
            workspaceSlug,
            projectId.toString(),
            savedCommentId.current,
            {
              asset_ids: uploadedAssetIds.current,
            }
          );
        } else {
          await fileService.updateBulkWorkspaceAssetsUploadStatus(workspaceSlug, savedCommentId.current, {
            asset_ids: uploadedAssetIds.current,
          });
        }
        uploadedAssetIds.current = [];
      }
      onSubmitCallback?.(savedCommentId.current);
      savedCommentId.current = null;
      attachmentDraft.commit();
      reset({
        comment_html: "<p></p>",
      });
      editorRef.current?.clearEditor();
    } catch {
      setSubmitError("评论未完整保存，输入内容已保留，请重试。");
    } finally {
      submissionLock.current = false;
    }
  };

  const commentHTML = watch("comment_html");
  const isEmpty = isCommentEmpty(commentHTML ?? undefined) && !attachmentDraft.attachmentIds.length;

  return (
    <div className={cn("sticky bottom-0 z-[4] bg-surface-1 sm:static")}>
      {submitError && (
        <p role="alert" className="mb-2 text-12 text-danger-primary">
          {submitError}
        </p>
      )}
      <Controller
        name="access"
        control={control}
        render={({ field: { onChange: onAccessChange, value: accessValue } }) => (
          <Controller
            name="comment_html"
            control={control}
            render={({ field: { value, onChange } }) => (
              <LiteTextEditor
                editable
                workspaceId={workspaceId}
                id={"add_comment_" + entityId}
                value={"<p></p>"}
                workspaceSlug={workspaceSlug}
                projectId={projectId}
                onEnterKeyPress={(e) => {
                  if (!isEmpty && !isSubmitting && !attachmentDraft.isBlocked) {
                    handleSubmit(onSubmit)(e);
                  }
                }}
                ref={editorRef}
                initialValue={value ?? "<p></p>"}
                containerClassName="min-h-min"
                onChange={(comment_json, comment_html) => onChange(comment_html)}
                accessSpecifier={accessValue ?? EIssueCommentAccessSpecifier.INTERNAL}
                handleAccessChange={onAccessChange}
                isSubmitting={isSubmitting}
                hasAttachments={attachmentDraft.attachmentIds.length > 0}
                isSubmitDisabled={attachmentDraft.isBlocked}
                onAttachFiles={supportsAttachments ? attachmentDraft.addFiles : undefined}
                attachmentContent={
                  <CommentAttachmentList
                    entries={attachmentDraft.entries}
                    error={attachmentDraft.error}
                    disabled={isSubmitting}
                    onRemove={attachmentDraft.remove}
                    onRetry={attachmentDraft.retry}
                  />
                }
                uploadFile={async (blockId, file) => {
                  const { asset_id } = await activityOperations.uploadCommentAsset(blockId, file);
                  uploadedAssetIds.current.push(asset_id);
                  return asset_id;
                }}
                duplicateFile={async (assetId: string) => {
                  const { asset_id } = await activityOperations.duplicateCommentAsset(assetId);
                  uploadedAssetIds.current.push(asset_id);
                  return asset_id;
                }}
                showToolbarInitially={showToolbarInitially}
                parentClassName="p-2"
                displayConfig={{
                  fontSize: "small-font",
                }}
              />
            )}
          />
        )}
      />
    </div>
  );
});
