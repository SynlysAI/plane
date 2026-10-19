/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { useForm } from "react-hook-form";
import type { EditorRefApi } from "@plane/editor";
import { CloseOutline, TickOutline } from "@makeplane/propel/icons";
// plane imports
import type { TCommentsOperations, TIssueComment } from "@plane/types";
import { cn, isCommentEmpty } from "@plane/utils";
// components
import { LiteTextEditor } from "@/components/editor/lite-text";
import { useFileSize } from "@/hooks/use-file-size";
import { CommentAttachmentList } from "../attachment-list";
import { useCommentAttachments } from "../use-comment-attachments";

type Props = {
  activityOperations: TCommentsOperations;
  comment: TIssueComment;
  isEditing: boolean;
  projectId?: string;
  readOnlyEditorRef: EditorRefApi | null;
  setIsEditing: (isEditing: boolean) => void;
  workspaceId: string;
  workspaceSlug: string;
};

export const CommentCardEditForm = observer(function CommentCardEditForm(props: Props) {
  const {
    activityOperations,
    comment,
    isEditing,
    projectId,
    readOnlyEditorRef,
    setIsEditing,
    workspaceId,
    workspaceSlug,
  } = props;
  // refs
  const editorRef = useRef<EditorRefApi>(null);
  const submissionLock = useRef(false);
  const [submitError, setSubmitError] = useState("");
  const { maxFileSize } = useFileSize();
  const attachmentDraft = useCommentAttachments(activityOperations, maxFileSize, comment.file_attachments);
  const supportsAttachments = !!activityOperations.uploadCommentAttachment;
  // form info
  const {
    formState: { isSubmitting },
    handleSubmit,
    setFocus,
    watch,
    setValue,
  } = useForm<Partial<TIssueComment>>({
    defaultValues: { comment_html: comment?.comment_html },
  });
  const commentHTML = watch("comment_html");

  const isEmpty = isCommentEmpty(commentHTML) && !attachmentDraft.attachmentIds.length;
  const isEditorReadyToDiscard = editorRef.current?.isEditorReadyToDiscard();
  const isSubmitButtonDisabled = isSubmitting || !isEditorReadyToDiscard;
  const isDisabled = isSubmitting || isEmpty || isSubmitButtonDisabled || attachmentDraft.isBlocked;

  const onEnter = async (formData: Partial<TIssueComment>) => {
    if (submissionLock.current || isEmpty || attachmentDraft.isBlocked || !editorRef.current?.isEditorReadyToDiscard())
      return;
    submissionLock.current = true;
    setSubmitError("");
    try {
      await activityOperations.updateComment(comment.id, {
        ...formData,
        ...(supportsAttachments ? { attachment_ids: attachmentDraft.attachmentIds } : {}),
      });
      attachmentDraft.commit();
      readOnlyEditorRef?.setEditorValue(formData?.comment_html ?? "<p></p>");
      setIsEditing(false);
    } catch {
      setSubmitError("评论未保存，输入内容及附件已保留，请重试。");
    } finally {
      submissionLock.current = false;
    }
  };

  useEffect(() => {
    if (isEditing) {
      setFocus("comment_html");
    }
  }, [isEditing, setFocus]);

  return (
    <form className="flex flex-col gap-2">
      {submitError && (
        <p role="alert" className="text-12 text-danger-primary">
          {submitError}
        </p>
      )}
      <div>
        <LiteTextEditor
          editable
          workspaceId={workspaceId}
          workspaceSlug={workspaceSlug}
          ref={editorRef}
          id={comment.id}
          initialValue={commentHTML ?? ""}
          value={null}
          onChange={(_comment_json, comment_html) => setValue("comment_html", comment_html)}
          onEnterKeyPress={(e) => {
            if (!isDisabled) {
              handleSubmit(onEnter)(e);
            }
          }}
          showSubmitButton={false}
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
            const { asset_id } = await activityOperations.uploadCommentAsset(blockId, file, comment.id);
            return asset_id;
          }}
          duplicateFile={async (assetId: string) => {
            const { asset_id } = await activityOperations.duplicateCommentAsset(assetId, comment.id);
            return asset_id;
          }}
          projectId={projectId}
          parentClassName="p-2 bg-surface-1"
          displayConfig={{
            fontSize: "small-font",
          }}
        />
      </div>
      <div className="flex gap-2 self-end">
        {!isEmpty && (
          <button
            type="button"
            aria-label="保存评论"
            onClick={handleSubmit(onEnter)}
            disabled={isDisabled}
            className={cn(
              "group grid size-7 place-items-center rounded-lg border border-success-subtle bg-success-subtle shadow-raised-100 duration-300",
              isDisabled ? "" : "hover:bg-success-subtle-1"
            )}
          >
            <TickOutline className="size-4 text-success-primary" />
          </button>
        )}
        <button
          type="button"
          aria-label="取消编辑"
          disabled={isSubmitting}
          className={cn(
            "group grid size-7 place-items-center rounded-lg border border-danger-subtle bg-danger-subtle shadow-raised-100 duration-300",
            isSubmitting ? "" : "hover:bg-danger-subtle-hover"
          )}
          onClick={() => {
            void attachmentDraft.cancel();
            setIsEditing(false);
            editorRef.current?.setEditorValue(comment.comment_html ?? "<p></p>");
          }}
        >
          <CloseOutline className="size-4 text-danger-primary" />
        </button>
      </div>
    </form>
  );
});
