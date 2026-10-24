import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuid } from "uuid";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { Avatar } from "@makeplane/propel/components/avatar";
import type { EditorRefApi } from "@plane/editor";
import type { TPeriodicReport, TReportComment, TReportCommentThread, TReportSelectionAnchor } from "@plane/types";
import { Button } from "@plane/propel/button";
import { LiteTextEditor } from "@/components/editor/lite-text";
import { formatResearchDateTime } from "@/components/research/common/research-format";
import { ResearchReportService } from "@/services/research/report.service";
import { isCommentEmpty } from "@plane/utils";

const COMMENTS_PANEL_ID = "research-report-comments-panel";
const COMMENTS_PANEL_STORAGE_KEY = "research_report_comments_panel_open";

/** Read the browser-level report discussion panel preference. */
function readCommentsPanelPreference(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(COMMENTS_PANEL_STORAGE_KEY) !== "false";
}

/** Keep the report discussion panel preference in the current browser.
 *
 * Returns:
 * - `open`: whether the expanded discussion panel is visible.
 * - `setOpen`: updates and persists the panel preference.
 * - `openForDiscussion`: expands the panel for anchored discussion entry points.
 */
export function useResearchReportCommentsPanel() {
  const [open, setOpen] = useState(readCommentsPanelPreference);

  useEffect(() => {
    window.localStorage.setItem(COMMENTS_PANEL_STORAGE_KEY, String(open));
  }, [open]);

  const openForDiscussion = useCallback(() => setOpen(true), []);

  return { open, setOpen, openForDiscussion };
}

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
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
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
  collapsed,
  onCollapsedChange,
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
      if (!onFocusThread(threadId)) setActionError("这条讨论引用的原文已变化，暂不能在正文定位。");
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

  if (collapsed) {
    return (
      <aside
        id={COMMENTS_PANEL_ID}
        className="flex h-11 w-full shrink-0 items-center justify-between self-start rounded-xl border border-subtle bg-surface-1 px-2 xl:sticky xl:top-5 xl:h-auto xl:w-12 xl:flex-col xl:justify-start xl:gap-3 xl:py-3"
      >
        <button
          type="button"
          aria-expanded="false"
          aria-controls={COMMENTS_PANEL_ID}
          aria-label="展开讨论"
          title="展开讨论"
          className="flex size-8 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-surface-2 hover:text-primary"
          onClick={() => onCollapsedChange(false)}
        >
          <PanelRightOpen className="size-4" aria-hidden="true" />
        </button>
        <span className="text-11 font-medium text-tertiary xl:[writing-mode:vertical-rl]">讨论</span>
      </aside>
    );
  }

  return (
    <aside
      id={COMMENTS_PANEL_ID}
      className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-subtle bg-surface-1 xl:sticky xl:top-5 xl:max-h-[calc(100vh-2.5rem)] xl:w-[340px] xl:shrink-0"
    >
      <header className="flex shrink-0 flex-col gap-3 border-b border-subtle px-3.5 py-3">
        <div>
          <h2 className="text-14 font-semibold text-primary">讨论</h2>
          <p className="mt-0.5 text-11 text-tertiary">固定于正式版本 v{report.latest_official_version ?? "—"}</p>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div
            className="flex items-center gap-0.5 rounded-md bg-surface-2 p-0.5"
            role="tablist"
            aria-label="讨论状态过滤"
          >
            {(["OPEN", "RESOLVED", "ALL"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={filter === item}
                className={`rounded px-2 py-1 text-11 transition-colors ${
                  filter === item ? "bg-surface-1 text-primary" : "text-tertiary hover:text-secondary"
                }`}
                onClick={() => setFilter(item)}
              >
                {item === "OPEN" ? "开放" : item === "RESOLVED" ? "已解决" : "全部"}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-expanded="true"
            aria-controls={COMMENTS_PANEL_ID}
            aria-label="收起讨论"
            title="收起讨论"
            className="flex size-7 items-center justify-center rounded-md text-tertiary transition-colors hover:bg-surface-2 hover:text-primary"
            onClick={() => onCollapsedChange(true)}
          >
            <PanelRightClose className="size-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5">
        {actionError && (
          <p role="alert" className="rounded-md bg-danger-subtle px-2.5 py-2 text-12 text-danger-primary">
            {actionError}
          </p>
        )}
        {loading && <p className="text-12 text-tertiary">讨论加载中</p>}
        {loadError && (
          <div
            role="alert"
            className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary"
          >
            讨论加载失败
            <button type="button" className="ml-2 underline" onClick={() => setRefresh((value) => value + 1)}>
              重试
            </button>
          </div>
        )}
        {!loading && !loadError && !canComment && (
          <p className="text-12 leading-5 text-tertiary">报告提交生成正式版本后，有查看权限的成员可以参与讨论。</p>
        )}

        {canComment && (draftAnchor || generalComposerOpen) && (
          <section className="rounded-lg border border-subtle bg-canvas p-3">
            {draftAnchor ? (
              <blockquote className="border-accent-primary/60 mb-3 rounded-md border-l-2 bg-surface-2 px-2.5 py-2 text-12 leading-5 text-secondary">
                {draftAnchor.selected_text}
              </blockquote>
            ) : (
              <p className="mb-3 text-12 font-medium text-secondary">全篇讨论</p>
            )}
            <CommentComposer
              workspaceSlug={workspaceSlug}
              workspaceId={workspaceId}
              title="发起讨论"
              onCancel={() => {
                setGeneralComposerOpen(false);
                onDraftConsumed();
              }}
              onSave={async (html, requestId) => {
                const created = await service.createReportCommentThread(workspaceSlug, report.id, {
                  anchor: draftAnchor,
                  comment_html: html,
                  request_id: requestId,
                });
                handleThreadCreated(created);
              }}
            />
          </section>
        )}

        {canComment && !draftAnchor && !generalComposerOpen && (
          <Button variant="secondary" size="sm" onClick={() => setGeneralComposerOpen(true)}>
            发起全篇讨论
          </Button>
        )}

        <div className="flex flex-col gap-3">
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
            <p className="rounded-lg border border-subtle px-3 py-3 text-12 text-tertiary">暂无符合条件的讨论。</p>
          )}
        </div>
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
      onError("讨论状态更新失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      ref={articleRef}
      data-thread-id={thread.id}
      className={`rounded-lg border p-3 ${active ? "border-accent-primary/60 bg-canvas" : "border-subtle bg-canvas/60"}`}
      aria-label={thread.quoted_text ? `讨论：${thread.quoted_text}` : "全篇讨论"}
    >
      <div className="flex items-start justify-between gap-2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onFocus}>
          {thread.quoted_text ? (
            <blockquote className="border-accent-primary/60 rounded-md border-l-2 bg-surface-2 px-2.5 py-2 text-12 leading-5 text-secondary">
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
            title="回复讨论"
            onCancel={onReplyToggle}
            onSave={async (html, requestId) => {
              const root = thread.comments[0];
              const created = await service.createReportCommentReply(workspaceSlug, thread.report, thread.id, {
                comment_html: html,
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
              onCancel={() => setEditing(false)}
              onSave={async (html) => {
                const updated = await service.updateReportComment(workspaceSlug, thread.report, comment.id, {
                  comment_html: html,
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
  onCancel,
  onSave,
}: {
  workspaceSlug: string;
  workspaceId: string;
  title: string;
  initialHtml?: string;
  onCancel?: () => void;
  onSave: (html: string, requestId: string) => Promise<void>;
}) {
  const editor = useRef<EditorRefApi>(null);
  const requestId = useRef(uuid());
  const [html, setHtml] = useState(initialHtml);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const empty = isCommentEmpty(html);

  const save = async () => {
    if (busy || empty) return;
    setBusy(true);
    setError("");
    try {
      await onSave(html, requestId.current);
      setHtml("<p></p>");
      editor.current?.clearEditor();
      requestId.current = uuid();
    } catch {
      setError("评论保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-md bg-surface-2 p-2">
      <LiteTextEditor
        ref={editor}
        id={`${title}-${workspaceSlug}`}
        editable={!busy}
        workspaceId={workspaceId}
        workspaceSlug={workspaceSlug}
        initialValue={html}
        value={null}
        placeholder="输入讨论内容，可 @ 相关成员。"
        disabledExtensions={["image", "issue-embed"]}
        uploadFile={async () => {
          throw new Error("报告讨论暂不支持图片。");
        }}
        duplicateFile={async () => {
          throw new Error("报告讨论暂不支持图片。");
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
