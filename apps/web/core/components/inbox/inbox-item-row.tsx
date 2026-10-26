/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { cn } from "@plane/utils";
import type { TInboxItem } from "@plane/types";
import {
  INBOX_ACTION_LABELS,
  INBOX_CATEGORY_LABELS,
  INBOX_KIND_LABELS,
  INBOX_SOURCE_LABELS,
  INBOX_URGENCY_LABELS,
  inboxLabel,
} from "./inbox-labels";

/** Format a timestamp as a short, locale-neutral relative time. */
function formatRelativeTime(value: string) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "";
  const diffMinutes = Math.round((Date.now() - timestamp) / 60_000);
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  if (diffMinutes < 1_440) return `${Math.floor(diffMinutes / 60)} 小时前`;
  if (diffMinutes < 28_800) return `${Math.floor(diffMinutes / 1_440)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(timestamp);
}

/** Resolve the concise source label for an inbox item. */
function sourceLabel(item: TInboxItem) {
  return inboxLabel(INBOX_SOURCE_LABELS, item.source);
}

type Props = {
  item: TInboxItem;
  compact?: boolean;
  selected?: boolean;
  onSelect?: (item: TInboxItem) => void;
};

export function InboxItemRow({ item, compact = false, selected = false, onSelect }: Props) {
  const unread = item.read_at === null || item.read_at === undefined;
  return (
    <button
      type="button"
      onClick={() => onSelect?.(item)}
      className={cn(
        "group flex w-full items-start gap-3 border-b border-subtle px-4 text-left transition-colors",
        compact ? "py-2.5" : "py-3.5",
        selected ? "bg-layer-1/50" : unread ? "bg-accent-primary/5" : "bg-transparent",
        "hover:bg-layer-1/60"
      )}
    >
      <span
        data-testid={unread ? "inbox-unread-indicator" : undefined}
        className={cn("mt-2 size-1.5 flex-shrink-0 rounded-full", unread ? "bg-accent-primary" : "bg-transparent")}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-3">
          <span className="truncate text-11 font-medium text-tertiary">
            {sourceLabel(item)} · {inboxLabel(INBOX_CATEGORY_LABELS, item.category)}
          </span>
          <time className="flex-shrink-0 text-11 text-tertiary" dateTime={item.updated_at}>
            {formatRelativeTime(item.updated_at)}
          </time>
        </span>
        <span
          className={cn(
            "mt-1 block truncate",
            compact ? "text-12" : "text-13",
            unread ? "font-medium text-primary" : "font-normal text-secondary"
          )}
        >
          {item.title}
        </span>
        {item.summary && !compact && (
          <span className="mt-1 line-clamp-2 block text-12 leading-5 text-tertiary">{item.summary}</span>
        )}
        <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-11 text-tertiary">
          <span>{inboxLabel(INBOX_KIND_LABELS, item.kind)}</span>
          {item.next_action && <span>下一步：{inboxLabel(INBOX_ACTION_LABELS, item.next_action)}</span>}
          {item.due_at && (
            <span className={item.urgency === "OVERDUE" ? "text-danger-primary" : undefined}>
              {inboxLabel(INBOX_URGENCY_LABELS, item.urgency ?? "NORMAL")}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}
