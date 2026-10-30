// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TInboxItem } from "@plane/types";

import { InboxItemRow } from "@/components/inbox/inbox-item-row";

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
    due_at: "2026-10-26T12:00:00Z",
    urgency: "DUE_TODAY",
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

beforeEach(() => {
  vi.setSystemTime(new Date("2026-10-26T03:00:00Z"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

it("renders source, action, urgency and unread presentation", async () => {
  await act(async () => root.render(<InboxItemRow item={inboxItem()} compact={false} selected={false} />));

  expect(container.querySelector('[data-testid="inbox-unread-indicator"]')).not.toBeNull();
  expect(container.textContent).toContain("科研任务 · 待办");
  expect(container.textContent).toContain("提交技术路线说明");
  expect(container.textContent).toContain("下一步：提交");
  expect(container.textContent).toContain("今天截止");
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-26T02:00:00Z");
});

it("renders feedback notifications with the platform source label", async () => {
  await act(async () =>
    root.render(
      <InboxItemRow
        item={inboxItem({
          id: "notification:feedback:1",
          kind: "notification",
          category: "system",
          source: "research_feedback",
          object_id: "feedback-1",
          entity_name: "research_feedback",
          entity_identifier: "feedback-1",
          title: "反馈有新回复",
          summary: "已复现，正在优化。",
          action: "replied",
          route: "/lab/feedback?feedback_id=feedback-1",
          due_at: undefined,
          urgency: undefined,
          status: undefined,
        })}
        compact={false}
      />
    )
  );

  expect(container.textContent).toContain("平台反馈 · 系统");
  expect(container.textContent).toContain("反馈有新回复");
  expect(container.textContent).toContain("已复现，正在优化。");
});

it("renders a work item name without duplicating the context label", async () => {
  await act(async () =>
    root.render(
      <InboxItemRow
        item={inboxItem({
          id: "notification:issue:1",
          kind: "notification",
          category: "work_item",
          source: "issue",
          object_id: "11111111-1111-1111-1111-111111111111",
          entity_name: "issue",
          entity_identifier: "11111111-1111-1111-1111-111111111111",
          title: "催化剂界面失活机理研究",
          summary: "added assignee",
          action: "updated",
        })}
        compact={false}
      />
    )
  );

  expect(container.textContent).toContain("工作项");
  expect(container.textContent).toContain("催化剂界面失活机理研究");
  expect(container.textContent).toContain("added assignee");
  expect(container.textContent).not.toContain("工作项 · 工作项");
});

it("does not show an unread indicator for read items", async () => {
  await act(async () =>
    root.render(<InboxItemRow item={inboxItem({ read_at: "2026-10-26T02:30:00Z" })} compact={false} />)
  );

  expect(container.querySelector('[data-testid="inbox-unread-indicator"]')).toBeNull();
  expect(container.textContent).toContain("提交技术路线说明");
});

it("invokes selection without changing the item object", async () => {
  const item = inboxItem({ read_at: "2026-10-26T02:30:00Z" });
  const onSelect = vi.fn();
  await act(async () => root.render(<InboxItemRow item={item} onSelect={onSelect} />));
  await act(async () => container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

  expect(onSelect).toHaveBeenCalledWith(item);
  expect(item.read_at).toBe("2026-10-26T02:30:00Z");
});
