// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TInboxItem, TInboxPaginatedInfo, TInboxUnreadCounts } from "@plane/types";

const mocks = vi.hoisted(() => ({
  fetchInbox: vi.fn(),
  fetchUnreadCounts: vi.fn(),
  updateItem: vi.fn(),
  markAllRead: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@/services/inbox.service", () => ({
  default: {
    fetchInbox: mocks.fetchInbox,
    fetchUnreadCounts: mocks.fetchUnreadCounts,
    updateItem: mocks.updateItem,
    markAllRead: mocks.markAllRead,
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => "/lab/home/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@makeplane/propel/components/tooltip", () => ({
  Tooltip: ({ children }: { children: unknown }) => children,
}));

vi.mock("@makeplane/propel/icons", () => ({
  InboxOutline: () => null,
}));

vi.mock("@plane/utils", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  getNumberCount: (count: number) => (count > 9 ? "9+" : String(count)),
}));

const { InboxPreviewPopover } = await import("@/components/inbox/inbox-preview-popover");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function item(id: string, title: string, route?: string): TInboxItem {
  return {
    id,
    schema_version: "inbox.v1",
    kind: id.startsWith("todo:") ? "todo" : "notification",
    category: id.startsWith("todo:") ? "todo" : "mention",
    source: id.startsWith("todo:") ? "CHAIN_TASK" : "issue",
    object_id: id,
    entity_name: "issue",
    entity_identifier: id,
    dedupe_key: id,
    title,
    summary: undefined,
    actor: undefined,
    action: "SUBMIT",
    route,
    due_at: undefined,
    urgency: undefined,
    status: "ASSIGNED",
    business_status: "ASSIGNED",
    handling_status: "TODO",
    next_action: "SUBMIT",
    created_at: "2026-10-26T01:00:00Z",
    updated_at: "2026-10-26T02:00:00Z",
    read_at: id.includes("read") ? "2026-10-26T02:30:00Z" : undefined,
    archived_at: undefined,
    snoozed_till: undefined,
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

beforeEach(() => {
  vi.setSystemTime(new Date("2026-10-26T03:00:00Z"));
  mocks.fetchInbox.mockResolvedValue({
    schema_version: "inbox.v1",
    results: [item("todo:CHAIN_TASK:1", "提交技术路线说明", "/lab/research/todos")],
    count: 1,
    total_count: 1,
    next_cursor: undefined,
    unread_counts: counts(2),
    degraded_sources: [],
  } satisfies TInboxPaginatedInfo);
  mocks.fetchUnreadCounts.mockResolvedValue(counts(2));
  mocks.updateItem.mockResolvedValue({ unread_counts: counts(1), results: [], degraded_sources: [] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
});

async function renderPopover() {
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <MemoryRouter>
          <InboxPreviewPopover workspaceSlug="lab" />
        </MemoryRouter>
      </SWRConfig>
    )
  );
}

it("opens a server-backed preview and shows the unified badge", async () => {
  await renderPopover();
  const trigger = container.querySelector('button[aria-label="通知，2 条未读"]');
  expect(trigger).not.toBeNull();

  await act(async () => trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  expect(mocks.fetchInbox).toHaveBeenCalledWith("lab", { per_page: 8 });
  expect(mocks.fetchUnreadCounts).toHaveBeenCalledWith("lab");
  expect(container.textContent).toContain("2 条未读");
  expect(container.textContent).toContain("提交技术路线说明");
  expect(container.querySelector('a[href="/lab/notifications/"]')).not.toBeNull();
});

it("marks one item read and navigates without marking sibling items read", async () => {
  mocks.fetchInbox.mockResolvedValue({
    schema_version: "inbox.v1",
    results: [
      item("todo:CHAIN_TASK:1", "提交技术路线说明", "/lab/research/todos"),
      item("todo:CHAIN_TASK:2-unread", "退回的实验记录"),
    ],
    count: 2,
    total_count: 2,
    next_cursor: undefined,
    unread_counts: counts(2),
    degraded_sources: [],
  } satisfies TInboxPaginatedInfo);
  await renderPopover();
  await act(async () =>
    container
      .querySelector('button[aria-label="通知，2 条未读"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  );

  const row = [...container.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("提交技术路线说明")
  );
  await act(async () => row?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  expect(mocks.updateItem).toHaveBeenCalledWith("lab", "todo:CHAIN_TASK:1", "read");
  expect(mocks.push).toHaveBeenCalledWith("/lab/research/todos");
});

it("closes the preview with Escape", async () => {
  await renderPopover();
  await act(async () =>
    container
      .querySelector('button[aria-label="通知，2 条未读"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
  );
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();

  await act(async () => container.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
