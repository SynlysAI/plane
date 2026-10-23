import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { Avatar } from "@makeplane/propel/components/avatar";
import type { EditorRefApi } from "@plane/editor";
import type {
  TPeriodicReport,
  TReportComment,
  TReportCommentFeedbackType,
  TReportCommentThread,
  TReportSelectionAnchor,
} from "@plane/types";
import { Button } from "@plane/propel/button";
import { LiteTextEditor } from "@/components/editor/lite-text";
import { formatResearchDateTime } from "@/components/research/common/research-format";
import { ResearchReportService } from "@/services/research/report.service";
import { isCommentEmpty } from "@plane/utils";

const FEEDBACK_TYPE_LABELS: Record<TReportCommentFeedbackType, string> = {
  DISCUSSION: "讨论",
  SUGGESTION: "修改建议",
  CORRECTION: "内容纠错",
  QUESTION: "问题",
  APPROVAL: "人工认可",
  REJECTION: "人工否定",
};

type Props = {
  report: TPeriodicReport;
  workspaceSlug: string;
  workspaceId: string;
  locale: string;
  draftAnchor: TReportSelectionAnchor | null;
  onDraftConsumed: () => void;
  onFocusThread: (threadId: string) => boolean;
  onAnchorsChange: (anchors: Array<{ threadId: string; anchor: TReportSelectionAnchor }>) => void;
  activeThreadId: string | null;
  onActiveThreadIdChange: (threadId: string | null) => void;
};

/** 报告评论侧栏：所有讨论都固定在创建时的正式快照版本。 */
export function ResearchReportComments({
  report,
  workspaceSlug,
  workspaceId,
  locale,
  draftAnchor,
  onDraftConsumed,
  onFocusThread,
  onAnchorsChange,
  activeThreadId,
  onActiveThreadIdChange,
}: Props) {
  const service = useMemo(() => new ResearchReportService(), []);
  const [threads, setThreads] = useState<TReportCommentThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [canComment, setCanComment] = useState(false);
  const [filter, setFilter] = useState<"OPEN" | "RESOLVED" | "ALL">("OPEN");
  const [generalComposerOpen, setGeneralComposerOpen] = useState(false);
  const [replyThreadId, setReplyThreadId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [refresh, setRefresh] = useState(0);

  const load = useCallback(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    service
      .getReportCommentThreads(workspaceSlug, report.id, filter)
      .then((payload) => {
        if (!active) return;
        setThreads(payload.results);
        setCanComment(payload.can_comment);
        return undefined;
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
  }, [filter, report.id, service, workspaceSlug]);

  useEffect(() => load(), [load, refresh]);

  useEffect(() => {
    onAnchorsChange(
      threads.flatMap((thread) => (thread.anchor ? [{ threadId: thread.id, anchor: thread.anchor }] : []))
    );
  }, [onAnchorsChange, threads]);

  useEffect(() => {
    if (!activeThreadId) return;
    const thread = threads.find((item) => item.id === activeThreadId);
    if (thread && filter !== "ALL" && thread.status !== filter) setFilter("ALL");
  }, [activeThreadId, filter, threads]);

  const updateThread = useCallback(
    (thread: TReportCommentThread) => {
      setThreads((current) => {
        if (filter !== "ALL" && thread.status !== filter) {
          return current.filter((item) => item.id !== thread.id);
        }
        return current.map((item) => (item.id === thread.id ? thread : item));
      });
    },
    [filter]
  );

  const updateComment = useCallback((comment: TReportComment) => {
    setThreads((current) =>
      current.map((thread) =>
        thread.id === comment.thread
          ? {
              ...thread,
              comments: thread.comments.map((item) => (item.id === comment.id ? comment : item)),
            }
          : thread
      )
    );
  }, []);

  const focusThread = useCallback(
    (threadId: string) => {
      onActiveThreadIdChange(threadId);
      if (!onFocusThread(threadId)) setActionError("这条批注引用的原文已变化，暂不能在正文定位。");
    },
    [onActiveThreadIdChange, onFocusThread]
  );

  const handleThreadCreated = useCallback(
    (thread: TReportCommentThread) => {
      setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
      onActiveThreadIdChange(thread.id);
      setFilter("OPEN");
      setGeneralComposerOpen(false);
      setReplyThreadId(null);
      onDraftConsumed();
    },
    [onActiveThreadIdChange, onDraftConsumed]
  );

  return (
    <aside className="flex min-w-0 flex-col gap-3 border-subtle xl:sticky xl:top-0 xl:w-80 xl:shrink-0 xl:border-l xl:pl-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-14 font-semibold text-primary">批注与讨论</h2>
          <p className="mt-0.5 text-11 text-tertiary">围绕正式版本 v{report.latest_official_version ?? "—"}</p>
        </div>
        <div className="flex items-center gap-1" role="tablist" aria-label="批注状态过滤">
          {(["OPEN", "RESOLVED", "ALL"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={filter === item}
              className={`rounded-md px-2 py-1 text-11 ${
                filter === item ? "bg-surface-2 text-primary" : "text-tertiary hover:text-secondary"
              }`}
              onClick={() => setFilter(item)}
            >
              {item === "OPEN" ? "开放" : item === "RESOLVED" ? "已解决" : "全部"}
            </button>
          ))}
        </div>
      </header>

      {actionError && (
        <p role="alert" className="text-12 text-danger-primary">
          {actionError}
        </p>
      )}
      {loading && <p className="text-12 text-tertiary">批注加载中</p>}
      {loadError && (
        <div role="alert" className="text-12 text-danger-primary">
          批注加载失败
          <button type="button" className="ml-2 underline" onClick={() => setRefresh((value) => value + 1)}>
            重试
          </button>
        </div>
      )}
      {!loading && !loadError && !canComment && (
        <p className="text-12 text-tertiary">报告提交生成正式版本后，有查看权限的成员可以参与批注。</p>
      )}

      {canComment && (draftAnchor || generalComposerOpen) && (
        <section className="border-b border-subtle pb-3">
          {draftAnchor ? (
            <blockquote className="border-accent-primary/50 mb-2 border-l-2 pl-2 text-12 text-secondary">
              {draftAnchor.selected_text}
            </blockquote>
          ) : (
            <p className="mb-2 text-12 text-tertiary">发起全篇讨论</p>
          )}
          <CommentComposer
            workspaceSlug={workspaceSlug}
            workspaceId={workspaceId}
            title="发起批注"
            onCancel={() => {
              setGeneralComposerOpen(false);
              onDraftConsumed();
            }}
            onSave={async (html, feedbackType, requestId) => {
              const created = await service.createReportCommentThread(workspaceSlug, report.id, {
                anchor: draftAnchor,
                comment_html: html,
                feedback_type: feedbackType,
                request_id: requestId,
              });
              handleThreadCreated(created);
            }}
          />
        </section>
      )}

      {canComment && !draftAnchor && !generalComposerOpen && (
        <Button variant="secondary" size="sm" onClick={() => setGeneralComposerOpen(true)}>
          全篇讨论
        </Button>
      )}

      <div className="flex flex-col gap-4">
        {threads.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            workspaceSlug={workspaceSlug}
            workspaceId={workspaceId}
            locale={locale}
            active={thread.id === activeThreadId}
            replyOpen={replyThreadId === thread.id}
            onReplyToggle={() => setReplyThreadId((current) => (current === thread.id ? null : thread.id))}
            onFocus={() => focusThread(thread.id)}
            onUpdate={updateThread}
            onCommentUpdate={updateComment}
            onError={setActionError}
          />
        ))}
        {!loading && !loadError && threads.length === 0 && (
          <p className="text-12 text-tertiary">暂无符合条件的批注。</p>
        )}
      </div>
    </aside>
  );
}

function ThreadCard({
  thread,
  workspaceSlug,
  workspaceId,
  locale,
  active,
  replyOpen,
  onReplyToggle,
  onFocus,
  onUpdate,
  onCommentUpdate,
  onError,
}: {
  thread: TReportCommentThread;
  workspaceSlug: string;
  workspaceId: string;
  locale: string;
  active: boolean;
  replyOpen: boolean;
  onReplyToggle: () => void;
  onFocus: () => void;
  onUpdate: (thread: TReportCommentThread) => void;
  onCommentUpdate: (comment: TReportComment) => void;
  onError: (message: string) => void;
}) {
  const service = useMemo(() => new ResearchReportService(), []);
  const articleRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (active) articleRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [active]);

  const changeStatus = async (status: TReportCommentThread["status"]) => {
    if (busy) return;
    setBusy(true);
    onError("");
    try {
      onUpdate(await service.updateReportCommentThreadStatus(workspaceSlug, thread.report, thread.id, status));
    } catch {
      onError("批注状态更新失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      ref={articleRef}
      data-thread-id={thread.id}
      className={`rounded-lg border p-3 ${active ? "border-accent-primary/50 bg-surface-1" : "border-subtle"}`}
      aria-label={thread.quoted_text ? `批注：${thread.quoted_text}` : "全篇讨论"}
    >
      <div className="flex items-start justify-between gap-2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onFocus}>
          {thread.quoted_text ? (
            <blockquote className="border-accent-primary/50 border-l-2 pl-2 text-12 text-secondary">
              {thread.quoted_text}
            </blockquote>
          ) : (
            <span className="text-12 font-medium text-secondary">全篇讨论</span>
          )}
          <span className="mt-1 block text-11 text-tertiary">
            正式版本 v{thread.snapshot_version} · {thread.status === "OPEN" ? "开放" : "已解决"}
          </span>
        </button>
        {thread.can_resolve && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void changeStatus(thread.status === "OPEN" ? "RESOLVED" : "OPEN")}
          >
            {thread.status === "OPEN" ? "解决" : "重新打开"}
          </Button>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-3">
        {thread.comments.map((comment) => (
          <CommentCard
            key={comment.id}
            comment={comment}
            thread={thread}
            workspaceSlug={workspaceSlug}
            workspaceId={workspaceId}
            locale={locale}
            onCommentUpdate={onCommentUpdate}
            onError={onError}
          />
        ))}
      </div>

      {replyOpen && (
        <div className="mt-3 border-t border-subtle pt-3">
          <CommentComposer
            workspaceSlug={workspaceSlug}
            workspaceId={workspaceId}
            title="回复批注"
            onCancel={onReplyToggle}
            onSave={async (html, feedbackType, requestId) => {
              const root = thread.comments[0];
              const created = await service.createReportCommentReply(workspaceSlug, thread.report, thread.id, {
                comment_html: html,
                feedback_type: feedbackType,
                parent: root?.id ?? null,
                request_id: requestId,
              });
              onUpdate({ ...thread, comments: [...thread.comments, created] });
              onReplyToggle();
            }}
          />
        </div>
      )}
      {!replyOpen && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={onReplyToggle}>
          回复
        </Button>
      )}
    </article>
  );
}

function CommentCard({
  comment,
  thread,
  workspaceSlug,
  workspaceId,
  locale,
  onCommentUpdate,
  onError,
}: {
  comment: TReportComment;
  thread: TReportCommentThread;
  workspaceSlug: string;
  workspaceId: string;
  locale: string;
  onCommentUpdate: (comment: TReportComment) => void;
  onError: (message: string) => void;
}) {
  const service = useMemo(() => new ResearchReportService(), []);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const submitFeedback = async () => {
    if (busy) return;
    setBusy(true);
    onError("");
    try {
      const feedback = await service.submitReportCommentFeedback(workspaceSlug, thread.report, comment.id);
      onCommentUpdate({
        ...comment,
        can_submit_ai_feedback: false,
        ai_feedback: {
          id: feedback.id,
          status: feedback.status,
          submitted_at: feedback.submitted_at,
          agent_session: feedback.agent_session,
        },
      });
    } catch {
      onError("AI 反馈提交失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  const deleteComment = async () => {
    if (busy) return;
    setBusy(true);
    onError("");
    try {
      await service.deleteReportComment(workspaceSlug, thread.report, comment.id);
      onCommentUpdate({
        ...comment,
        comment_html: "<p>已删除</p>",
        comment_stripped: "已删除",
        can_edit: false,
        can_delete: false,
      });
      setConfirmDelete(false);
    } catch {
      onError("评论删除失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex gap-2">
      <Avatar
        size="2xs"
        alt={comment.actor_detail.display_name}
        fallback={comment.actor_detail.display_name[0]}
        src={comment.actor_detail.avatar_url ?? ""}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-11">
          <span className="font-medium text-primary">{comment.actor_detail.display_name}</span>
          <span className="text-tertiary">{FEEDBACK_TYPE_LABELS[comment.feedback_type]}</span>
          <time className="text-tertiary" dateTime={comment.created_at}>
            {formatResearchDateTime(comment.created_at, locale)}
          </time>
          {comment.edited_at && <span className="text-tertiary">已编辑</span>}
          {comment.ai_feedback && <span className="text-accent-primary">已提交 AI 反馈</span>}
        </div>
        {editing ? (
          <div className="mt-2">
            <CommentComposer
              workspaceSlug={workspaceSlug}
              workspaceId={workspaceId}
              title="保存修改"
              initialHtml={comment.comment_html}
              initialFeedbackType={comment.feedback_type}
              onCancel={() => setEditing(false)}
              onSave={async (html, feedbackType) => {
                const updated = await service.updateReportComment(workspaceSlug, thread.report, comment.id, {
                  comment_html: html,
                  feedback_type: feedbackType,
                });
                onCommentUpdate(updated);
                setEditing(false);
              }}
            />
          </div>
        ) : (
          <LiteTextEditor
            key={comment.updated_at}
            id={`report-comment-${comment.id}`}
            editable={false}
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
            initialValue={comment.comment_html}
            value={null}
            containerClassName="p-0"
            editorClassName="text-12"
          />
        )}

        <div className="mt-1 flex flex-wrap items-center gap-2">
          {comment.can_edit && !editing && (
            <button
              type="button"
              className="text-11 text-tertiary hover:text-secondary"
              onClick={() => setEditing(true)}
            >
              编辑
            </button>
          )}
          {comment.can_delete && !confirmDelete && (
            <button
              type="button"
              className="text-11 text-tertiary hover:text-danger-primary"
              onClick={() => setConfirmDelete(true)}
            >
              删除
            </button>
          )}
          {comment.can_delete && confirmDelete && (
            <>
              <span className="text-11 text-tertiary">确认删除？</span>
              <button
                type="button"
                className="text-11 text-danger-primary"
                disabled={busy}
                onClick={() => void deleteComment()}
              >
                确认
              </button>
              <button type="button" className="text-11 text-tertiary" onClick={() => setConfirmDelete(false)}>
                取消
              </button>
            </>
          )}
          {comment.can_submit_ai_feedback && !comment.ai_feedback && (
            <button
              type="button"
              className="text-11 text-secondary"
              disabled={busy}
              onClick={() => void submitFeedback()}
            >
              提交为 AI 反馈
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CommentComposer({
  workspaceSlug,
  workspaceId,
  title,
  initialHtml = "<p></p>",
  initialFeedbackType = "DISCUSSION",
  onCancel,
  onSave,
}: {
  workspaceSlug: string;
  workspaceId: string;
  title: string;
  initialHtml?: string;
  initialFeedbackType?: TReportCommentFeedbackType;
  onCancel?: () => void;
  onSave: (html: string, feedbackType: TReportCommentFeedbackType, requestId: string) => Promise<void>;
}) {
  const editor = useRef<EditorRefApi>(null);
  const requestId = useRef(uuid());
  const [html, setHtml] = useState(initialHtml);
  const [feedbackType, setFeedbackType] = useState(initialFeedbackType);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const empty = isCommentEmpty(html);

  const save = async () => {
    if (busy || empty) return;
    setBusy(true);
    setError("");
    try {
      await onSave(html, feedbackType, requestId.current);
      setHtml("<p></p>");
      setFeedbackType("DISCUSSION");
      editor.current?.clearEditor();
      requestId.current = uuid();
    } catch {
      setError("评论保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1">
        {(Object.keys(FEEDBACK_TYPE_LABELS) as TReportCommentFeedbackType[]).map((type) => (
          <button
            key={type}
            type="button"
            className={`rounded-md px-2 py-1 text-11 ${
              feedbackType === type ? "bg-surface-2 text-primary" : "text-tertiary hover:text-secondary"
            }`}
            onClick={() => setFeedbackType(type)}
          >
            {FEEDBACK_TYPE_LABELS[type]}
          </button>
        ))}
      </div>
      <LiteTextEditor
        ref={editor}
        id={`${title}-${workspaceSlug}`}
        editable={!busy}
        workspaceId={workspaceId}
        workspaceSlug={workspaceSlug}
        initialValue={html}
        value={null}
        placeholder="输入批注，可 @ 相关成员。"
        disabledExtensions={["image", "issue-embed"]}
        uploadFile={async () => {
          throw new Error("报告批注暂不支持图片。");
        }}
        duplicateFile={async () => {
          throw new Error("报告批注暂不支持图片。");
        }}
        isSubmitting={busy}
        isSubmitDisabled={empty}
        showSubmitButton={false}
        showToolbarInitially={false}
        parentClassName="p-2"
        onEnterKeyPress={() => void save()}
        onChange={(_json, nextHtml, options) => {
          if (options?.isMigrationUpdate) return;
          requestId.current = uuid();
          setHtml(nextHtml);
        }}
      />
      {error && <p className="mt-1 text-12 text-danger-primary">{error}</p>}
      <div className="mt-2 flex justify-end gap-2">
        {onCancel && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={onCancel}>
            取消
          </Button>
        )}
        <Button variant="primary" size="sm" disabled={busy || empty} onClick={() => void save()}>
          {busy ? "保存中" : title}
        </Button>
      </div>
    </div>
  );
}
