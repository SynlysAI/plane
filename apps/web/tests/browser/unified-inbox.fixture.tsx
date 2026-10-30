import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { SWRConfig } from "swr";
import type { TInboxItem, TInboxPaginatedInfo, TInboxUnreadCounts } from "@plane/types";
import inboxService from "@/services/inbox.service";
import { InboxDetail, InboxPreviewPopover, InboxSidebar } from "@/components/inbox";
// oxlint-disable-next-line import/no-unassigned-import -- Browser fixture uses the real visual system.
import "../../styles/globals.css";

const now = new Date("2026-10-26T11:00:00+08:00").toISOString();

function inboxItem(overrides: Partial<TInboxItem>): TInboxItem {
  return {
    id: "todo:CHAIN_TASK:task-1",
    schema_version: "inbox.v1",
    kind: "todo",
    category: "todo",
    source: "CHAIN_TASK",
    object_id: "task-1",
    entity_name: "research_chain_task",
    entity_identifier: "task-1",
    dedupe_key: "todo:CHAIN_TASK:task-1",
    title: "提交技术路线说明",
    summary: "催化剂界面失活机理研究 · 技术路线节点",
    actor: { id: "student-1", display_name: "隔离学生", avatar_url: null },
    action: "SUBMIT",
    route: "/isolated-test/research/todos",
    due_at: "2026-10-26T18:00:00+08:00",
    urgency: "DUE_TODAY",
    status: "ASSIGNED",
    business_status: "ASSIGNED",
    handling_status: "TODO",
    next_action: "SUBMIT",
    created_at: now,
    updated_at: now,
    read_at: undefined,
    archived_at: undefined,
    snoozed_till: undefined,
    ...overrides,
  };
}

const items = [
  inboxItem({
    id: "notification:issue:11111111-1111-1111-1111-111111111111",
    kind: "notification",
    category: "work_item",
    source: "issue",
    object_id: "11111111-1111-1111-1111-111111111111",
    entity_name: "issue",
    entity_identifier: "11111111-1111-1111-1111-111111111111",
    dedupe_key: "notification:issue:11111111-1111-1111-1111-111111111111",
    title: "催化剂界面失活机理研究与再生策略验证——界面组分演化跟踪实验",
    summary: "added assignee",
    actor: { id: "researcher-1", display_name: "实验负责人", avatar_url: null },
    action: "updated",
    route: "/isolated-test/projects/22222222-2222-2222-2222-222222222222/issues/11111111-1111-1111-1111-111111111111",
    due_at: undefined,
    urgency: undefined,
    status: undefined,
    business_status: undefined,
    handling_status: undefined,
    next_action: undefined,
    preview: {
      type: "work_item",
      workspace_slug: "isolated-test",
      project_id: "22222222-2222-2222-2222-222222222222",
      entity_id: "11111111-1111-1111-1111-111111111111",
    },
  }),
  inboxItem({}),
  inboxItem({
    id: "notification:mention-1",
    kind: "notification",
    category: "mention",
    source: "research_report",
    object_id: "report-1",
    entity_name: "research_report",
    entity_identifier: "report-1",
    dedupe_key: "notification:mention-1",
    title: "周报评论提到你",
    summary: "2026-W43 报告有新批注",
    action: "comment.created",
    route: "/isolated-test/research/reports/report-1",
    due_at: undefined,
    urgency: undefined,
    status: "SUBMITTED",
    business_status: undefined,
    handling_status: undefined,
    next_action: undefined,
  }),
  inboxItem({
    id: "todo:OFFICE_APPROVAL:approval-1",
    category: "approval",
    source: "OFFICE_APPROVAL",
    entity_name: "research_approval",
    title: "确认耗材采购审批",
    summary: "行政流程 · 耗材采购",
    next_action: "APPROVE",
    urgency: "DUE_SOON",
    due_at: "2026-10-28T18:00:00+08:00",
  }),
];

const counts: TInboxUnreadCounts = {
  total_unread_count: 4,
  mention_unread_count: 1,
  todo_unread_count: 1,
  approval_unread_count: 1,
  review_unread_count: 0,
  work_item_unread_count: 1,
  system_unread_count: 0,
};

const page: TInboxPaginatedInfo = {
  schema_version: "inbox.v1",
  results: items,
  count: items.length,
  total_count: items.length,
  next_cursor: undefined,
  unread_counts: counts,
  degraded_sources: [],
};

inboxService.fetchInbox = async () => page;
inboxService.fetchUnreadCounts = async () => counts;
inboxService.updateItem = async () => ({
  schema_version: "inbox.v1",
  results: [],
  unread_counts: { ...counts, total_unread_count: 2 },
  degraded_sources: [],
});
inboxService.markAllRead = async () => ({
  schema_version: "inbox.v1",
  results: [],
  unread_counts: { ...counts, total_unread_count: 0 },
  degraded_sources: [],
});

/** Render the preview popover and full-page list/detail side by side for visual review. */
function UnifiedInboxFixture() {
  return (
    <SWRConfig value={{ provider: () => new Map() }}>
      <MemoryRouter initialEntries={["/isolated-test/notifications?inbox_tab=all"]}>
        <Routes>
          <Route
            path="/:workspaceSlug/notifications"
            element={
              <main className="min-h-screen bg-canvas text-primary">
                <header className="flex h-12 items-center justify-end border-b border-subtle bg-canvas px-4">
                  <InboxPreviewPopover workspaceSlug="isolated-test" />
                </header>
                <div className="flex h-[calc(100vh-3rem)] w-full overflow-hidden">
                  <InboxSidebar workspaceSlug="isolated-test" />
                  <div className="min-w-0 flex-1">
                    <InboxDetail workspaceSlug="isolated-test" />
                  </div>
                </div>
              </main>
            }
          />
        </Routes>
      </MemoryRouter>
    </SWRConfig>
  );
}

document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(<UnifiedInboxFixture />);
