// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TPeriodicReport, TReportCommentThread } from "@plane/types";

const mocks = vi.hoisted(() => ({
  getReportCommentThreads: vi.fn(),
  createReportCommentThread: vi.fn(),
  createReportCommentReply: vi.fn(),
  updateReportCommentThreadStatus: vi.fn(),
  submitReportCommentFeedback: vi.fn(),
}));

vi.mock("@plane/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@plane/utils")>()),
  isCommentEmpty: (value: string) => value.trim().length === 0,
}));
vi.mock("@makeplane/propel/components/avatar", () => ({
  Avatar: ({ fallback }: { fallback: string }) => <span aria-label={fallback}>{fallback}</span>,
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
vi.mock("@/components/editor/lite-text", () => ({
  LiteTextEditor: React.forwardRef(function LiteTextEditor(
    {
      initialValue,
      onChange,
    }: {
      initialValue: string;
      onChange: (json: object, html: string) => void;
    },
    ref
  ) {
    React.useImperativeHandle(ref, () => ({ clearEditor: vi.fn() }));
    return (
      <div>
        <textarea
          aria-label="评论编辑器"
          defaultValue={initialValue}
          onChange={(event) => onChange({}, event.target.value)}
        />
        <button type="button" ref={undefined} onClick={() => undefined}>
          editor
        </button>
        <span ref={ref as React.Ref<HTMLSpanElement>} />
      </div>
    );
  }),
}));
vi.mock("@/services/research/report.service", () => ({
  ResearchReportService: class {
    getReportCommentThreads = mocks.getReportCommentThreads;
    createReportCommentThread = mocks.createReportCommentThread;
    createReportCommentReply = mocks.createReportCommentReply;
    updateReportCommentThreadStatus = mocks.updateReportCommentThreadStatus;
    submitReportCommentFeedback = mocks.submitReportCommentFeedback;
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

const anchor = {
  version: 1 as const,
  block_id: "block-1",
  block_type: "paragraph",
  selected_text: "催化剂活性实验",
  prefix: "本周完成",
  suffix: "，结果稳定",
  start_offset: 4,
  end_offset: 11,
};

const comment = {
  id: "comment-1",
  thread: "thread-1",
  parent: null,
  actor: "advisor-1",
  actor_detail: { id: "advisor-1", display_name: "导师", avatar_url: null },
  comment_html: "<p>请补充重复实验。</p>",
  comment_stripped: "请补充重复实验。",
  feedback_type: "SUGGESTION" as const,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
  edited_at: null,
  can_edit: true,
  can_delete: true,
  can_submit_ai_feedback: true,
  ai_feedback: null,
};

const thread = {
  id: "thread-1",
  report: "report-1",
  anchor,
  quoted_text: "催化剂活性实验",
  snapshot_version: 1,
  content_hash: "hash",
  status: "OPEN" as const,
  status_updated_at: "2026-10-01T10:00:00Z",
  status_updated_by: null,
  created_by: "advisor-1",
  created_by_detail: comment.actor_detail,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
  last_activity_at: "2026-10-01T10:00:00Z",
  comment_count: 1,
  can_resolve: true,
  comments: [comment],
};

const report = {
  id: "report-1",
  latest_official_version: 1,
} as TPeriodicReport;

async function renderComments(focusResult = true) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onFocusThread = vi.fn(() => focusResult);
  const onDraftConsumed = vi.fn();
  const onAnchorsChange = vi.fn();
  const onActiveThreadIdChange = vi.fn();
  await act(async () => {
    root.render(
      <div>
        {/* eslint-disable-next-line @typescript-eslint/no-var-requires */}
        {await import("@/components/research/reports/report-comments").then(({ ResearchReportComments }) => (
          <ResearchReportComments
            report={report}
            workspaceSlug="lab"
            workspaceId="workspace-1"
            locale="zh-CN"
            draftAnchor={anchor}
            onDraftConsumed={onDraftConsumed}
            onFocusThread={onFocusThread}
            onAnchorsChange={onAnchorsChange}
            activeThreadId={null}
            onActiveThreadIdChange={onActiveThreadIdChange}
          />
        ))}
      </div>
    );
  });
  return { container, onFocusThread, onDraftConsumed, onAnchorsChange, onActiveThreadIdChange };
}

function button(container: HTMLElement, text: string) {
  return [...container.querySelectorAll("button")].find((item) => item.textContent === text);
}

describe("ResearchReportComments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getReportCommentThreads.mockResolvedValue({
      results: [thread as TReportCommentThread],
      count: 1,
      status_filter: "OPEN",
      can_comment: true,
      snapshot_version: 1,
    });
  });

  it("loads threads, exposes anchors, and focuses the body from a quote", async () => {
    const { container, onFocusThread, onAnchorsChange, onActiveThreadIdChange } = await renderComments();

    expect(container.textContent).toContain("催化剂活性实验");
    expect(onAnchorsChange).toHaveBeenCalledWith([{ threadId: "thread-1", anchor }]);
    act(() => button(container, "催化剂活性实验正式版本 v1 · 开放")?.click());
    expect(onFocusThread).toHaveBeenCalledWith("thread-1");
    expect(onActiveThreadIdChange).toHaveBeenCalledWith("thread-1");
  });

  it("creates an anchored thread from a report selection", async () => {
    mocks.createReportCommentThread.mockResolvedValue(thread);
    const { container, onDraftConsumed } = await renderComments();
    const editor = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="评论编辑器"]');
    expect(editor).toBeTruthy();
    await act(async () => {
      editor?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      button(container, "发起批注")?.click();
    });

    expect(mocks.createReportCommentThread).toHaveBeenCalledWith("lab", "report-1", {
      anchor,
      comment_html: "<p></p>",
      feedback_type: "DISCUSSION",
      request_id: expect.any(String),
    });
    expect(onDraftConsumed).toHaveBeenCalled();
  });

  it("supports explicit AI feedback and resolve state transitions", async () => {
    mocks.submitReportCommentFeedback.mockResolvedValue({});
    mocks.updateReportCommentThreadStatus.mockResolvedValue({ ...thread, status: "RESOLVED" });
    const { container } = await renderComments();

    await act(async () => button(container, "提交为 AI 反馈")?.click());
    expect(mocks.submitReportCommentFeedback).toHaveBeenCalledWith("lab", "report-1", "comment-1");
    expect(container.textContent).toContain("已提交 AI 反馈");

    await act(async () => button(container, "解决")?.click());
    expect(mocks.updateReportCommentThreadStatus).toHaveBeenCalledWith("lab", "report-1", "thread-1", "RESOLVED");
    expect(container.textContent).toContain("暂无符合条件的批注。");
  });

  it("keeps an unresolvable quote in the sidebar instead of jumping to other content", async () => {
    const { container } = await renderComments(false);

    act(() => button(container, "催化剂活性实验正式版本 v1 · 开放")?.click());

    expect(container.textContent).toContain("这条批注引用的原文已变化，暂不能在正文定位。");
    expect(container.textContent).toContain("催化剂活性实验");
  });
});
