import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { EditOutline, DeleteOutline, MoreHorizontalOutline, RefreshOutline } from "@makeplane/propel/icons";
import { Avatar } from "@makeplane/propel/components/avatar";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { EditorRefApi } from "@plane/editor";
import type { TResearchChainNodeTask, TResearchTaskComment } from "@plane/types";
import { CustomMenu } from "@plane/ui";
import { getFileURL, isCommentEmpty } from "@plane/utils";
import { LiteTextEditor } from "@/components/editor/lite-text";
import { formatResearchDateTime } from "@/components/research/common/research-format";
import { ResearchChainTaskService } from "@/services/research/chain-task.service";

type Props = { task: TResearchChainNodeTask; workspaceSlug: string; locale: string; order: "asc" | "desc" };

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
            onSave={async (html, requestId) => {
              const comment = await service.createTaskComment(workspaceSlug, task.chain, task.node, task.id, {
                comment_html: html,
                request_id: requestId,
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
            initialHtml={comment.comment_html}
            onCancel={() => setEditing(false)}
            onSave={async (html) => {
              const updated = await service.updateTaskComment(
                workspaceSlug,
                task.chain,
                task.node,
                task.id,
                comment.id,
                html
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
          />
        )}
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

function CommentEditor({
  task,
  workspaceSlug,
  initialHtml = "<p></p>",
  onSave,
  onCancel,
}: {
  task: TResearchChainNodeTask;
  workspaceSlug: string;
  initialHtml?: string;
  onSave: (html: string, requestId: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const editor = useRef<EditorRefApi>(null);
  const requestId = useRef(uuid());
  const busyRef = useRef(false);
  const [html, setHtml] = useState(initialHtml);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = useCallback(async () => {
    if (busyRef.current || isCommentEmpty(html)) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave(html, requestId.current);
      setHtml("<p></p>");
      editor.current?.clearEditor();
      requestId.current = uuid();
    } catch {
      setError(t("research.chain_tasks.comments.save_failed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [html, onSave, t]);
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
        disabledExtensions={["image", "issue-embed"]}
        disabledMenuItems={["image"]}
        uploadFile={async () => ""}
        duplicateFile={async () => ""}
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
      <div className="mt-2 flex justify-end gap-2">
        {onCancel && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
            {t("research.common.cancel")}
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={busy || isCommentEmpty(html)} onClick={() => void save()}>
          {busy
            ? t("research.chain_tasks.saving")
            : t(onCancel ? "research.chain_tasks.save" : "research.chain_tasks.comments.post")}
        </Button>
      </div>
    </div>
  );
}
