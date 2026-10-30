// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TInboxItem, TInboxPaginatedInfo, TInboxUnreadCounts } from "@plane/types";

import { matchesInboxListKey } from "@/hooks/use-inbox";
import { InboxDetail } from "@/components/inbox/inbox-detail";
import { InboxSidebar } from "@/components/inbox/inbox-sidebar";

const mocks = vi.hoisted(() => ({
  fetchInbox: vi.fn(),
  fetchUnreadCounts: vi.fn(),
  updateItem: vi.fn(),
  markAllRead: vi.fn(),
  setToast: vi.fn(),
}));

const previewMocks = vi.hoisted(() => ({
  setPeekWorkItem: vi.fn(),
  PreviewOverviewComponent: () => null,
}));

vi.mock("@/services/inbox.service", () => ({
  default: {
    fetchInbox: mocks.fetchInbox,
    fetchUnreadCounts: mocks.fetchUnreadCounts,
    updateItem: mocks.updateItem,
    markAllRead: mocks.markAllRead,
  },
}));

vi.mock("@/hooks/use-notification-preview", () => ({
  useNotificationPreview: () => ({
    isWorkItem: true,
    PeekOverviewComponent: previewMocks.PreviewOverviewComponent,
    setPeekWorkItem: previewMocks.setPeekWorkItem,
  }),
}));

vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { ERROR: "ERROR" },
  setToast: mocks.setToast,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => (key === "back_to_home" ? "返回首页" : key) }),
}));

vi.mock("@plane/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function inboxItem(overrides: Partial<TInboxItem> = {}): TInboxItem {
  return {
    id: "todo:CHAIN_TASK:1",
    schema_version: "inbox.v1",
    kind: "todo",
    category: "todo",
    source: "CHAIN_TASK",
    object_id: "1",
    entity_name: "research_chain_task",
    entity_identifier: "1",
    dedupe_key: "todo:CHAIN_TASK:1",
    title: "提交技术路线说明",
    summary: "科研项目 · 技术路线",
    actor: undefined,
    action: "SUBMIT",
    route: "/lab/research/todos",
    due_at: undefined,
    urgency: undefined,
    status: "ASSIGNED",
    business_status: "ASSIGNED",
    handling_status: "TODO",
    next_action: "SUBMIT",
    created_at: "2026-10-26T01:00:00Z",
    updated_at: "2026-10-26T02:00:00Z",
    read_at: undefined,
    archived_at: undefined,
    snoozed_till: undefined,
    ...overrides,
  };
}

function counts(total: number): TInboxUnreadCounts {
  return {
    total_unread_count: total,
    mention_unread_count: 0,
    todo_unread_count: total,
    approval_unread_count: 0,
    review_unread_count: 0,
    work_item_unread_count: 0,
    system_unread_count: 0,
  };
}

function page(item: TInboxItem, total: number): TInboxPaginatedInfo {
  return {
    schema_version: "inbox.v1",
    results: [item],
    count: 1,
    total_count: 1,
    next_cursor: undefined,
    unread_counts: counts(total),
    degraded_sources: [],
  };
}

beforeEach(() => {
  mocks.fetchInbox.mockResolvedValue(page(inboxItem(), 1));
  mocks.fetchUnreadCounts.mockResolvedValue(counts(1));
  mocks.updateItem.mockResolvedValue({
    schema_version: "inbox.v1",
    results: [],
    unread_counts: counts(0),
    degraded_sources: [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

/**
 * Render an inbox component with isolated SWR and router state.
 *
 * @param node Inbox component to render.
 * @returns Promise that resolves after React commits the tree.
 */
function render(node: React.ReactNode, selectedItemId = inboxItem().id) {
  return act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <MemoryRouter initialEntries={[`/lab/notifications?inbox_item=${encodeURIComponent(selectedItemId)}`]}>
          {node}
        </MemoryRouter>
      </SWRConfig>
    )
  );
}

it("marks a selected full-page item read without removing the unfinished todo", async () => {
  await render(<InboxSidebar workspaceSlug="lab" />);

  expect(container.querySelector('a[href="/lab/"]')?.textContent).toContain("返回首页");
  const row = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("提交技术路线说明")
  );
  await act(async () => row?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  expect(mocks.updateItem).toHaveBeenCalledWith("lab", "todo:CHAIN_TASK:1", "read");
  expect(container.querySelector('[data-testid="inbox-unread-indicator"]')).toBeNull();
  expect(container.textContent).toContain("提交技术路线说明");
});

it("embeds the selected work item and clears it after switching", async () => {
  const issueId = "11111111-1111-1111-1111-111111111111";
  const projectId = "22222222-2222-2222-2222-222222222222";
  const workItem = inboxItem({
    id: `notification:issue:${issueId}`,
    kind: "notification",
    category: "work_item",
    source: "issue",
    object_id: issueId,
    entity_name: "issue",
    entity_identifier: issueId,
    title: "催化剂界面失活机理研究",
    summary: "added assignee",
    action: "updated",
    route: `/lab/projects/${projectId}/issues/${issueId}`,
    read_at: "2026-10-26T02:30:00Z",
    preview: {
      type: "work_item",
      workspace_slug: "lab",
      project_id: projectId,
      entity_id: issueId,
    },
  });
  mocks.fetchInbox.mockResolvedValue(page(workItem, 0));

  const todo = inboxItem({ read_at: "2026-10-26T02:30:00Z" });
  mocks.fetchInbox.mockResolvedValue({
    ...page(workItem, 0),
    results: [workItem, todo],
    count: 2,
    total_count: 2,
  });
  await render(
    <>
      <InboxSidebar workspaceSlug="lab" />
      <InboxDetail workspaceSlug="lab" />
    </>,
    workItem.id
  );

  expect(previewMocks.setPeekWorkItem).toHaveBeenCalledWith({
    workspaceSlug: "lab",
    projectId,
    issueId,
  });
  expect(container.textContent).toContain("added assignee");

  const todoRow = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(todo.title));
  await act(async () => todoRow?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  expect(previewMocks.setPeekWorkItem).toHaveBeenLastCalledWith(undefined);
});

it("marks an item unread from the detail pane", async () => {
  mocks.fetchInbox.mockResolvedValue(page({ ...inboxItem(), read_at: "2026-10-26T02:30:00Z" }, 0));
  mocks.fetchUnreadCounts.mockResolvedValue(counts(0));
  mocks.updateItem.mockResolvedValueOnce({
    schema_version: "inbox.v1",
    results: [],
    unread_counts: counts(1),
    degraded_sources: [],
  });
  await render(<InboxDetail workspaceSlug="lab" />);

  const markUnread = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("标记未读")
  );
  await act(async () => markUnread?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  expect(mocks.updateItem).toHaveBeenCalledWith("lab", "todo:CHAIN_TASK:1", "unread");
});

it("targets only list caches for the same workspace", () => {
  const currentKey = 'UNIFIED_INBOX_lab_{"tab":"todos","per_page":50}';
  expect(matchesInboxListKey("lab", currentKey, undefined)).toBe(true);
  expect(matchesInboxListKey("lab", currentKey, currentKey)).toBe(false);
  expect(matchesInboxListKey("lab", "UNIFIED_INBOX_UNREAD_lab", undefined)).toBe(false);
  expect(matchesInboxListKey("admin", currentKey, undefined)).toBe(false);
});
