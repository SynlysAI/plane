import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AxiosHeaders } from "axios";
import { TranslationProvider } from "@plane/i18n";
import type { TPeriodicReport, TReportCommentThread } from "@plane/types";
import { StoreProvider } from "@/lib/store-context";
import { APIService } from "@/services/api.service";
import { ResearchReportComments } from "@/components/research/reports/report-comments";
// oxlint-disable-next-line import/no-unassigned-import -- shared fixture styles
import "./research-home-workbench.fixture.css";

const now = "2026-10-22T09:30:00Z";
const actor = { id: "advisor-1", display_name: "李明", avatar_url: null };

const thread = {
  id: "thread-1",
  report: "report-1",
  anchor: {
    version: 1,
    block_id: "block-method",
    block_type: "paragraph",
    selected_text: "催化剂活性实验",
    prefix: "本周完成",
    suffix: "，结果稳定",
    start_offset: 4,
    end_offset: 11,
  },
  quoted_text: "催化剂活性实验",
  snapshot_version: 2,
  content_hash: "fixture-hash",
  status: "OPEN",
  status_updated_at: now,
  status_updated_by: "advisor-1",
  status_updated_by_detail: actor,
  created_by: "advisor-1",
  created_by_detail: actor,
  created_at: now,
  updated_at: now,
  last_activity_at: now,
  comment_count: 2,
  can_resolve: true,
  comments: [
    {
      id: "comment-1",
      thread: "thread-1",
      parent: null,
      actor: "advisor-1",
      actor_detail: actor,
      comment_html: "<p>请补充三次重复实验的方差分析。</p>",
      comment_stripped: "请补充三次重复实验的方差分析。",
      feedback_type: "SUGGESTION",
      created_at: now,
      updated_at: now,
      edited_at: null,
      can_edit: true,
      can_delete: true,
      can_submit_ai_feedback: true,
      ai_feedback: null,
    },
    {
      id: "comment-2",
      thread: "thread-1",
      parent: "comment-1",
      actor: "student-1",
      actor_detail: { id: "student-1", display_name: "肖旭", avatar_url: null },
      comment_html: "<p>已补充，见第 3 节表 2。</p>",
      comment_stripped: "已补充，见第 3 节表 2。",
      feedback_type: "DISCUSSION",
      created_at: now,
      updated_at: now,
      edited_at: null,
      can_edit: false,
      can_delete: false,
      can_submit_ai_feedback: false,
      ai_feedback: null,
    },
  ],
} satisfies TReportCommentThread;

APIService.prototype.get = async () => ({
  data: {
    results: [thread],
    count: 1,
    status_filter: "OPEN",
    can_comment: true,
    snapshot_version: 2,
  },
  status: 200,
  statusText: "OK",
  headers: {},
  config: { headers: new AxiosHeaders() },
});

const report = {
  id: "report-1",
  latest_official_version: 2,
} as TPeriodicReport;

createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <TranslationProvider>
      <ReportCommentsFixture />
    </TranslationProvider>
  </StoreProvider>
);

/** Render the discussion panel with local state so collapse behavior stays inspectable. */
function ReportCommentsFixture() {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <main className="flex h-screen justify-end overflow-hidden bg-canvas p-6">
      <ResearchReportComments
        report={report}
        workspaceSlug="sample"
        workspaceId="workspace-1"
        locale="zh-CN"
        draftAnchor={null}
        onDraftConsumed={() => undefined}
        onFocusThread={() => true}
        onAnchorsChange={() => undefined}
        activeThreadId="thread-1"
        onActiveThreadIdChange={() => undefined}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
      />
    </main>
  );
}
