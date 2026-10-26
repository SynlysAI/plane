/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import Link from "next/link";
import { useSearchParams } from "react-router";
import {
  INBOX_ACTION_LABELS,
  INBOX_CATEGORY_LABELS,
  INBOX_KIND_LABELS,
  INBOX_SOURCE_LABELS,
  INBOX_STATUS_LABELS,
  INBOX_URGENCY_LABELS,
  inboxLabel,
} from "./inbox-labels";
// hooks
import { useInboxList, useInboxUnreadCounts } from "@/hooks/use-inbox";
// services
import inboxService from "@/services/inbox.service";

type Props = {
  workspaceSlug: string;
};

/** Format an inbox timestamp for the detail metadata grid. */
function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export function InboxDetail({ workspaceSlug }: Props) {
  const [searchParams] = useSearchParams();
  const selectedItemId = searchParams.get("inbox_item") ?? undefined;
  const currentTab = searchParams.get("inbox_tab") ?? "all";
  const { data, mutate: mutateList } = useInboxList(workspaceSlug, { tab: currentTab as never, per_page: 50 });
  const { mutate: mutateCounts } = useInboxUnreadCounts(workspaceSlug);
  const item = data?.results.find((candidate) => candidate.id === selectedItemId);

  if (!item) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div>
          <p className="text-14 font-medium text-primary">选择一条通知</p>
          <p className="mt-1 text-12 text-tertiary">左侧列表保留未读状态和业务上下文。</p>
        </div>
      </div>
    );
  }

  const handleMarkUnread = async () => {
    const response = await inboxService.updateItem(workspaceSlug, item.id, "unread");
    if (!response) return;
    await Promise.all([
      mutateList(
        (current) =>
          current && {
            ...current,
            results: current.results.map((row) => (row.id === item.id ? { ...row, read_at: undefined } : row)),
          },
        { revalidate: false }
      ),
      mutateCounts(response.unread_counts, { revalidate: false }),
    ]);
  };

  const metadata = [
    ["类型", inboxLabel(INBOX_KIND_LABELS, item.kind)],
    ["来源", inboxLabel(INBOX_SOURCE_LABELS, item.source)],
    ["状态", inboxLabel(INBOX_STATUS_LABELS, item.status)],
    ["紧急程度", inboxLabel(INBOX_URGENCY_LABELS, item.urgency)],
    ["下一步", inboxLabel(INBOX_ACTION_LABELS, item.next_action)],
    ["截止时间", item.due_at ? formatDateTime(item.due_at) : undefined],
    ["更新时间", formatDateTime(item.updated_at)],
  ].filter(([, value]) => Boolean(value));

  return (
    <article className="h-full overflow-y-auto bg-canvas">
      <header className="border-b border-subtle bg-surface-1 px-6 py-5">
        <p className="text-11 text-tertiary">{inboxLabel(INBOX_CATEGORY_LABELS, item.category)}</p>
        <h1 className="mt-1 text-20 font-semibold text-primary">{item.title}</h1>
        {item.summary && <p className="mt-2 max-w-3xl text-13 leading-6 text-secondary">{item.summary}</p>}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {item.route && (
            <Link
              href={item.route}
              className="rounded-md border border-subtle px-3 py-1.5 text-12 text-primary transition hover:bg-layer-1-hover"
            >
              打开来源
            </Link>
          )}
          <button
            type="button"
            onClick={handleMarkUnread}
            className="rounded-md px-3 py-1.5 text-12 text-secondary transition hover:bg-layer-1-hover hover:text-primary"
          >
            标记未读
          </button>
        </div>
      </header>

      <div className="px-6 py-5">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          {metadata.map(([label, value]) => (
            <div key={label} className="min-w-0 border-b border-subtle pb-3">
              <dt className="text-11 text-tertiary">{label}</dt>
              <dd className="mt-1 truncate text-13 text-primary">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </article>
  );
}
