import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { EditOutline, DeleteOutline, MoreHorizontalOutline, RefreshOutline } from "@makeplane/propel/icons";
import { Avatar } from "@makeplane/propel/components/avatar";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { researchEndpoints } from "@plane/constants";
import type { EditorRefApi } from "@plane/editor";
import type { TCommentAttachmentLimits, TResearchChainNodeTask, TResearchTaskComment } from "@plane/types";
import { CustomMenu } from "@plane/ui";
import { getFileURL, isCommentEmpty } from "@plane/utils";
import { CommentAttachmentList } from "@/components/comments/attachment-list";
import { useCommentAttachments } from "@/components/comments/use-comment-attachments";
import { LiteTextEditor } from "@/components/editor/lite-text";
import { formatResearchDateTime } from "@/components/research/common/research-format";
import { ResearchChainTaskService } from "@/services/research/chain-task.service";

type Props = { task: TResearchChainNodeTask; workspaceSlug: string; locale: string; order: "asc" | "desc" };

/** Build the authenticated inline-image base URL for one research task. */
function taskImageBase(task: TResearchChainNodeTask, workspaceSlug: string) {
  return `${researchEndpoints.chainNodeTask(workspaceSlug, task.chain, task.node, task.id)}comment-images/`;
}

export function ResearchTaskComments({ task, workspaceSlug, locale, order }: Props) {
  const { t } = useTranslation();
  const service = useMemo(() => new ResearchChainTaskService(), []);
  const [comments, setComments] = useState<TResearchTaskComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [canComment, setCanComment] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setComments([]);
    setCanComment(false);
    setLoadError(false);
    void service
      .getTaskComments(workspaceSlug, task.chain, task.node, task.id)
      .then((payload) => {
        if (!active) return null;
        setComments(payload.results);
        setCanComment(payload.can_comment);
        return null;
      })
      .catch(() => {
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [service, workspaceSlug, task.chain, task.node, task.id, refresh]);

  const sorted = useMemo(() => {
    // Sort a copy because the configured TypeScript library predates toSorted.
    // eslint-disable-next-line unicorn/no-array-sort
    return [...comments].sort((a, b) => (order === "asc" ? 1 : -1) * a.created_at.localeCompare(b.created_at));
  }, [comments, order]);
  const update = (comment: TResearchTaskComment) =>
    setComments((current) => current.map((item) => (item.id === comment.id ? comment : item)));

  return (
    <div className="mt-5" aria-label={t("research.chain_tasks.comments.title")}>
      <h4 className="mb-3 text-12 font-medium text-primary">{t("research.chain_tasks.comments.title")}</h4>
      {loading && (
        <p role="status" className="text-12 text-tertiary">
          {t("research.chain_tasks.comments.loading")}
        </p>
      )}
      {loadError && (
        <div role="alert" className="flex items-center gap-2 text-12 text-danger-primary">
          {t("research.chain_tasks.comments.load_failed")}
          <button
            type="button"
            title={t("research.chain_tasks.refresh")}
            aria-label={t("research.chain_tasks.refresh")}
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshOutline className="size-4" />
          </button>
        </div>
      )}
      <div className="space-y-4">
        {sorted.map((comment) => (
          <TaskComment
            key={comment.id}
            comment={comment}
            task={task}
            workspaceSlug={workspaceSlug}
            locale={locale}
            service={service}
            onUpdate={update}
            onDelete={() => setComments((items) => items.filter((item) => item.id !== comment.id))}
          />
        ))}
      </div>
      {!loading && !loadError && canComment && (
        <div className="mt-4">
          <CommentEditor
            task={task}
            workspaceSlug={workspaceSlug}
            service={service}
            onSave={async (html, requestId, attachmentIds) => {
              const comment = await service.createTaskComment(workspaceSlug, task.chain, task.node, task.id, {
                comment_html: html,
                request_id: requestId,
                attachment_ids: attachmentIds,
              });
              setComments((current) => [...current.filter((item) => item.id !== comment.id), comment]);
            }}
          />
        </div>
      )}
    </div>
  );
}

function TaskComment({
  comment,
  task,
  workspaceSlug,
  locale,
  service,
  onUpdate,
  onDelete,
}: {
  comment: TResearchTaskComment;
  task: TResearchChainNodeTask;
  workspaceSlug: string;
  locale: string;
  service: ResearchChainTaskService;
  onUpdate: (comment: TResearchTaskComment) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const imageBase = taskImageBase(task, workspaceSlug);
  return (
    <article className="flex gap-3" id={`task-comment-${comment.id}`}>
      <Avatar
        size="2xs"
        alt={comment.actor_detail.display_name}
        fallback={comment.actor_detail.display_name[0]}
        src={getFileURL(comment.actor_detail.avatar_url ?? "")}
      />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-12">
          <span className="font-medium text-primary">{comment.actor_detail.display_name}</span>
          <time className="text-tertiary" dateTime={comment.created_at}>
            {formatResearchDateTime(comment.created_at, locale)}
          </time>
          {comment.edited_at && <span className="text-tertiary">{t("research.chain_tasks.comments.edited")}</span>}
          {(comment.can_edit || comment.can_delete) && !editing && (
            <CustomMenu
              customButton={<MoreHorizontalOutline className="size-4" />}
              className="ml-auto"
              customButtonClassName="text-secondary"
              closeOnSelect
              ariaLabel={t("research.chain_tasks.more")}
            >
              {comment.can_edit && (
                <CustomMenu.MenuItem onClick={() => setEditing(true)}>
                  <EditOutline className="mr-2 size-3" />
                  {t("common.actions.edit")}
                </CustomMenu.MenuItem>
              )}
              {comment.can_delete && (
                <CustomMenu.MenuItem
                  className="text-danger-primary"
                  onClick={() => {
                    setDeleteError("");
                    setConfirmDelete(true);
                  }}
                >
                  <DeleteOutline className="mr-2 size-3" />
                  {t("common.actions.delete")}
                </CustomMenu.MenuItem>
              )}
            </CustomMenu>
          )}
        </div>
        {editing ? (
          <CommentEditor
            task={task}
            workspaceSlug={workspaceSlug}
            service={service}
            initialHtml={comment.comment_html}
            initialAttachments={comment.file_attachments ?? []}
            onCancel={() => setEditing(false)}
            onSave={async (html, _requestId, attachmentIds) => {
              const updated = await service.updateTaskComment(
                workspaceSlug,
                task.chain,
                task.node,
                task.id,
                comment.id,
                { comment_html: html, attachment_ids: attachmentIds }
              );
              onUpdate(updated);
              setEditing(false);
            }}
          />
        ) : (
          <LiteTextEditor
            key={comment.updated_at}
            id={`task-comment-${comment.id}`}
            editable={false}
            workspaceId={task.workspace}
            workspaceSlug={workspaceSlug}
            initialValue={comment.comment_html}
            parentClassName="border-none"
            containerClassName="!p-0"
            displayConfig={{ fontSize: "small-font" }}
            fileHandlerOverrides={{
              getAssetSrc: async (source) => source,
              getAssetDownloadSrc: async (source) => source,
              delete: async (source) => {
                if (!source.startsWith(imageBase)) return;
                await service.deleteTaskCommentImage(
                  workspaceSlug,
                  task.chain,
                  task.node,
                  task.id,
                  source.slice(imageBase.length).replace(/\/$/, "")
                );
              },
            }}
          />
        )}
        {!editing && <CommentAttachmentList attachments={comment.file_attachments ?? []} />}
        {confirmDelete && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-12" role="alert">
            <span>{t("research.chain_tasks.comments.confirm_delete")}</span>
            <Button size="sm" variant="secondary" disabled={deleting} onClick={() => setConfirmDelete(false)}>
              {t("research.common.cancel")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={deleting}
              onClick={async () => {
                if (deleting) return;
                setDeleting(true);
                try {
                  await service.deleteTaskComment(workspaceSlug, task.chain, task.node, task.id, comment.id);
                  onDelete();
                } catch {
                  setDeleteError(t("research.chain_tasks.comments.delete_failed"));
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {t("research.common.delete")}
            </Button>
            {deleteError && <span className="text-danger-primary">{deleteError}</span>}
          </div>
        )}
      </div>
    </article>
  );
}

/** Load workspace quotas through the research task-scoped endpoint. */
function useTaskCommentAttachmentLimits(
  service: ResearchChainTaskService,
  task: TResearchChainNodeTask,
  workspaceSlug: string
) {
  const [limits, setLimits] = useState<TCommentAttachmentLimits | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setLimits(null);
    setError(false);
    service
      .getTaskCommentAttachmentLimits(workspaceSlug, task.chain, task.node, task.id)
      .then((payload) => {
        if (active) setLimits(payload);
        return undefined;
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [service, task.chain, task.id, task.node, workspaceSlug]);

  return { limits, error };
}

function CommentEditor({
  task,
  workspaceSlug,
  service,
  initialHtml = "<p></p>",
  initialAttachments = [],
  onSave,
  onCancel,
}: {
  task: TResearchChainNodeTask;
  workspaceSlug: string;
  service: ResearchChainTaskService;
  initialHtml?: string;
  initialAttachments?: TResearchTaskComment["file_attachments"];
  onSave: (html: string, requestId: string, attachmentIds: string[]) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const editor = useRef<EditorRefApi>(null);
  const requestId = useRef(uuid());
  const busyRef = useRef(false);
  const [html, setHtml] = useState(initialHtml);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [imageError, setImageError] = useState("");
  const [imageUploadCount, setImageUploadCount] = useState(0);
  const { limits, error: limitsError } = useTaskCommentAttachmentLimits(service, task, workspaceSlug);
  const attachmentDraft = useCommentAttachments(
    {
      uploadCommentAttachment: (file) =>
        service.uploadTaskCommentAttachment(workspaceSlug, task.chain, task.node, task.id, file),
      discardCommentAttachment: (assetId) =>
        service.deleteTaskCommentAttachment(workspaceSlug, task.chain, task.node, task.id, assetId),
    },
    limits,
    initialAttachments
  );
  const imageBase = taskImageBase(task, workspaceSlug);
  const hasInlineImage = /<(img|image-component)\b/i.test(html);
  const isEmpty = isCommentEmpty(html) && !hasInlineImage && attachmentDraft.attachmentIds.length === 0;
  const blocked = attachmentDraft.isBlocked || imageUploadCount > 0;
  const save = useCallback(async () => {
    if (busyRef.current || isEmpty || blocked) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave(html, requestId.current, attachmentDraft.attachmentIds);
      setHtml("<p></p>");
      setImageError("");
      editor.current?.clearEditor();
      requestId.current = uuid();
      attachmentDraft.commit();
    } catch {
      setError(t("research.chain_tasks.comments.save_failed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [attachmentDraft, blocked, html, isEmpty, onSave, t]);
  const uploadImage = useCallback(
    async (_blockId: string, file: File) => {
      setImageUploadCount((count) => count + 1);
      try {
        const source = await service.uploadTaskCommentImage(workspaceSlug, task.chain, task.node, task.id, file);
        setImageError("");
        return source;
      } catch (failure) {
        setImageError(failure instanceof Error ? failure.message : "图片上传失败，请重试。");
        throw failure;
      } finally {
        setImageUploadCount((count) => count - 1);
      }
    },
    [service, task.chain, task.id, task.node, workspaceSlug]
  );
  return (
    <div>
      <LiteTextEditor
        ref={editor}
        id={`task-comment-editor-${task.id}-${onCancel ? "edit" : "create"}`}
        editable={!busy}
        workspaceId={task.workspace}
        workspaceSlug={workspaceSlug}
        initialValue={html}
        value={null}
        placeholder={t("research.chain_tasks.comments.placeholder")}
        disabledExtensions={["issue-embed"]}
        isSubmitting={busy}
        hasAttachments={attachmentDraft.attachmentIds.length > 0}
        isSubmitDisabled={blocked}
        onAttachFiles={attachmentDraft.addFiles}
        attachmentContent={
          <CommentAttachmentList
            entries={attachmentDraft.entries}
            error={limitsError ? "无法获取当前工作区附件限制" : attachmentDraft.error}
            disabled={busy}
            onRemove={attachmentDraft.remove}
            onRetry={attachmentDraft.retry}
          />
        }
        uploadFile={uploadImage}
        duplicateFile={async () => {
          throw new Error("请重新选择图片上传到这条任务评论。");
        }}
        fileHandlerOverrides={{
          getAssetSrc: async (source) => source,
          getAssetDownloadSrc: async (source) => source,
          validation: { maxFileSize: limits?.image.max_bytes ?? 20 * 1024 * 1024 },
          delete: async (source) => {
            if (!source.startsWith(imageBase)) return;
            await service.deleteTaskCommentImage(
              workspaceSlug,
              task.chain,
              task.node,
              task.id,
              source.slice(imageBase.length).replace(/\/$/, "")
            );
          },
          restore: async (source) => {
            if (!source.startsWith(imageBase)) return;
            await service.restoreTaskCommentImage(
              workspaceSlug,
              task.chain,
              task.node,
              task.id,
              source.slice(imageBase.length).replace(/\/$/, "")
            );
          },
        }}
        showSubmitButton={false}
        showToolbarInitially={false}
        parentClassName="p-2"
        onChange={(_json, nextHtml, options) => {
          if (options?.isMigrationUpdate) return;
          requestId.current = uuid();
          setHtml(nextHtml);
        }}
        onEnterKeyPress={() => void save()}
        displayConfig={{ fontSize: "small-font" }}
      />
      {error && (
        <p role="alert" className="mt-2 text-12 text-danger-primary">
          {error}
        </p>
      )}
      {imageError && (
        <p role="alert" className="mt-2 text-12 text-danger-primary">
          {imageError}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        {onCancel && (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || imageUploadCount > 0}
            onClick={() => void attachmentDraft.cancel().finally(onCancel)}
          >
            {t("research.common.cancel")}
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={busy || isEmpty || blocked} onClick={() => void save()}>
          {busy
            ? t("research.chain_tasks.saving")
            : t(onCancel ? "research.chain_tasks.save" : "research.chain_tasks.comments.post")}
        </Button>
      </div>
    </div>
  );
}
