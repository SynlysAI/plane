/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useState } from "react";
import { useSearchParams } from "react-router";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { cn } from "@plane/utils";
import type { TInboxTab } from "@plane/types";
// components
import { InboxItemRow } from "./inbox-item-row";
// hooks
import { inboxListKey, useInboxList, useInboxUnreadCounts, useInvalidateOtherInboxLists } from "@/hooks/use-inbox";
// services
import inboxService from "@/services/inbox.service";

const TABS: { value: TInboxTab; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "mentions", label: "@ 我" },
  { value: "todos", label: "待办" },
  { value: "approvals", label: "审批" },
  { value: "reviews", label: "评审" },
  { value: "system", label: "系统" },
];

type Props = {
  workspaceSlug: string;
};

export function InboxSidebar({ workspaceSlug }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = TABS.find((tab) => tab.value === searchParams.get("inbox_tab"))?.value ?? "all";
  const selectedItemId = searchParams.get("inbox_item") ?? undefined;
  const listParams = { tab: currentTab, per_page: 50 };
  const currentListKey = inboxListKey(workspaceSlug, listParams);
  const { data, isLoading, mutate: mutateList } = useInboxList(workspaceSlug, listParams);
  const { data: counts, mutate: mutateCounts } = useInboxUnreadCounts(workspaceSlug);
  const invalidateOtherInboxLists = useInvalidateOtherInboxLists(workspaceSlug, currentListKey);
  const [isFetchingMore, setIsFetchingMore] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const items = data?.results ?? [];

  const updateQuery = useCallback(
    (key: string, value?: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) params.set(key, value);
      else params.delete(key);
      setSearchParams(params);
    },
    [searchParams, setSearchParams]
  );

  const handleSelect = useCallback(
    async (item: (typeof items)[number]) => {
      updateQuery("inbox_item", item.id);
      if (item.read_at !== null && item.read_at !== undefined) return;
      try {
        const response = await inboxService.updateItem(workspaceSlug, item.id, "read");
        if (!response) return;
        await Promise.all([
          mutateList(
            (current) =>
              current && {
                ...current,
                results: current.results.map((row) =>
                  row.id === item.id ? { ...row, read_at: new Date().toISOString() } : row
                ),
              },
            { revalidate: false }
          ),
          mutateCounts(response.unread_counts, { revalidate: false }),
        ]);
        await invalidateOtherInboxLists();
      } catch (error) {
        console.error(error);
        setToast({
          type: TOAST_TYPE.ERROR,
          title: "标记已读失败",
          message: "请稍后重试，该通知仍保持未读。",
        });
      }
    },
    [invalidateOtherInboxLists, mutateCounts, mutateList, updateQuery, workspaceSlug]
  );

  const handleMarkAllRead = async () => {
    setIsMutating(true);
    try {
      const response = await inboxService.markAllRead(workspaceSlug);
      if (!response) return;
      await Promise.all([
        mutateList(
          (current) =>
            current && {
              ...current,
              results: current.results.map((item) => ({ ...item, read_at: new Date().toISOString() })),
            },
          { revalidate: false }
        ),
        mutateCounts(response.unread_counts, { revalidate: false }),
      ]);
      await invalidateOtherInboxLists();
    } catch (error) {
      console.error(error);
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "全部已读失败",
        message: "请稍后重试，未读状态已保留。",
      });
    } finally {
      setIsMutating(false);
    }
  };

  const handleLoadMore = async () => {
    const cursor = data?.next_cursor;
    if (!cursor) return;
    setIsFetchingMore(true);
    try {
      const nextPage = await inboxService.fetchInbox(workspaceSlug, {
        tab: currentTab,
        per_page: 50,
        cursor,
      });
      await mutateList(
        (current) =>
          current && nextPage ? { ...nextPage, results: [...current.results, ...nextPage.results] } : current,
        { revalidate: false }
      );
    } catch (error) {
      console.error(error);
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "加载通知失败",
        message: "请稍后重试。",
      });
    } finally {
      setIsFetchingMore(false);
    }
  };

  return (
    <aside className="h-full w-full flex-shrink-0 border-subtle bg-surface-1 md:w-3/12 md:border-r">
      <div className="flex h-full w-full flex-col">
        <div className="flex h-header flex-shrink-0 items-center justify-between border-b border-subtle px-4">
          <div>
            <p className="text-14 font-semibold text-primary">通知</p>
            <p className="text-11 text-tertiary">
              {counts?.total_unread_count ? `${counts.total_unread_count} 条未读` : "暂无未读"}
            </p>
          </div>
          <button
            type="button"
            onClick={handleMarkAllRead}
            disabled={isMutating || !counts?.total_unread_count}
            className="rounded-md px-2 py-1 text-12 text-secondary transition hover:bg-layer-1-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            全部已读
          </button>
        </div>

        <div className="flex flex-shrink-0 border-b border-subtle">
          {TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => updateQuery("inbox_tab", tab.value === "all" ? undefined : tab.value)}
              className={cn(
                "relative flex h-10 flex-1 items-center justify-center text-12 transition-colors",
                currentTab === tab.value ? "font-medium text-primary" : "text-secondary hover:text-primary"
              )}
            >
              {tab.label}
              {currentTab === tab.value && <span className="absolute bottom-0 h-px w-full bg-accent-primary" />}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="space-y-3 p-4">
              {[0, 1, 2].map((key) => (
                <div key={key} className="h-14 animate-pulse rounded-md bg-layer-1" />
              ))}
            </div>
          ) : items.length > 0 ? (
            <>
              {items.map((item) => (
                <InboxItemRow key={item.id} item={item} selected={selectedItemId === item.id} onSelect={handleSelect} />
              ))}
              {data?.next_cursor && (
                <div className="p-3">
                  <button
                    type="button"
                    onClick={handleLoadMore}
                    disabled={isFetchingMore}
                    className="w-full rounded-md border border-subtle px-3 py-2 text-12 text-secondary transition hover:bg-layer-1-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isFetchingMore ? "正在加载" : "显示更多"}
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center">
              <div>
                <p className="text-13 font-medium text-primary">暂无相关通知</p>
                <p className="mt-1 text-12 text-tertiary">切换标签或稍后刷新查看最新事项。</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
