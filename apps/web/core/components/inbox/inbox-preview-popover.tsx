/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Tooltip } from "@makeplane/propel/components/tooltip";
import { InboxOutline } from "@makeplane/propel/icons";
import type { TInboxUnreadCounts } from "@plane/types";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { cn, getNumberCount } from "@plane/utils";
// hooks
import { inboxListKey, useInboxList, useInboxUnreadCounts, useInvalidateOtherInboxLists } from "@/hooks/use-inbox";
// services
import inboxService from "@/services/inbox.service";
// components
import { InboxItemRow } from "./inbox-item-row";

type Props = {
  workspaceSlug: string;
};

export function InboxPreviewPopover({ workspaceSlug }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [isMutating, setIsMutating] = useState(false);
  const listParams = { read: "false" as const, per_page: 8 };
  const currentListKey = inboxListKey(workspaceSlug, listParams);
  const { data, mutate: mutateList } = useInboxList(workspaceSlug, listParams);
  const { data: counts, mutate: mutateCounts } = useInboxUnreadCounts(workspaceSlug);
  const invalidateOtherInboxLists = useInvalidateOtherInboxLists(workspaceSlug, currentListKey);
  const items = data?.results ?? [];
  const unreadCount = counts?.total_unread_count ?? 0;

  useEffect(() => {
    void mutateCounts();
  }, [mutateCounts, pathname]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    void mutateList();
    void mutateCounts();
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, mutateCounts, mutateList]);

  const applyResponse = useCallback(
    async (unreadCounts: TInboxUnreadCounts | undefined, itemId?: string) => {
      await Promise.all([
        mutateList(
          (current) =>
            current && {
              ...current,
              results: itemId ? current.results.filter((item) => item.id !== itemId) : [],
              count: itemId ? Math.max(0, current.count - 1) : 0,
              total_count: itemId ? Math.max(0, current.total_count - 1) : 0,
              next_cursor: itemId ? current.next_cursor : undefined,
            },
          { revalidate: false }
        ),
        mutateCounts(unreadCounts, { revalidate: false }),
      ]);
      await invalidateOtherInboxLists();
    },
    [invalidateOtherInboxLists, mutateCounts, mutateList]
  );

  const handleItemSelect = async (item: (typeof items)[number]) => {
    if (item.read_at === null || item.read_at === undefined) {
      setIsMutating(true);
      try {
        const response = await inboxService.updateItem(workspaceSlug, item.id, "read");
        await applyResponse(response?.unread_counts, item.id);
      } catch (error) {
        console.error(error);
        setToast({
          type: TOAST_TYPE.ERROR,
          title: "标记已读失败",
          message: "请稍后重试，该通知仍保持未读。",
        });
        return;
      } finally {
        setIsMutating(false);
      }
    }
    setIsOpen(false);
    if (item.route) router.push(item.route);
  };

  const handleMarkAllRead = async () => {
    setIsMutating(true);
    try {
      const response = await inboxService.markAllRead(workspaceSlug);
      await applyResponse(response?.unread_counts);
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

  return (
    <div ref={containerRef} className="relative">
      <Tooltip label="通知" side="bottom">
        <button
          type="button"
          aria-label={unreadCount > 0 ? `通知，${unreadCount} 条未读` : "通知"}
          aria-expanded={isOpen}
          aria-haspopup="dialog"
          onClick={() => setIsOpen((current) => !current)}
          className={cn(
            "relative flex size-8 items-center justify-center rounded-md text-secondary transition hover:bg-layer-1-hover hover:text-primary",
            (pathname?.includes("/notifications/") || isOpen) && "bg-layer-1-hover text-primary"
          )}
        >
          <InboxOutline className="size-5" />
          {unreadCount > 0 && (
            <span className="absolute top-0.5 right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger-primary px-1 text-[10px] leading-none text-white">
              {getNumberCount(unreadCount)}
            </span>
          )}
        </button>
      </Tooltip>

      {isOpen && (
        <div
          role="dialog"
          aria-label="通知预览"
          className="shadow-lg absolute right-0 z-50 mt-2 w-[min(380px,calc(100vw-32px))] overflow-hidden rounded-lg border border-subtle bg-surface-1"
        >
          <div className="flex items-center justify-between border-b border-subtle px-4 py-3">
            <div>
              <p className="text-13 font-semibold text-primary">通知</p>
              <p className="text-11 text-tertiary">{unreadCount > 0 ? `${unreadCount} 条未读` : "暂无未读"}</p>
            </div>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                disabled={isMutating}
                className="rounded-md px-2 py-1 text-12 text-secondary transition hover:bg-layer-1-hover hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                全部已读
              </button>
            )}
          </div>

          <div className="max-h-[360px] overflow-y-auto">
            {items.length > 0 ? (
              items.map((item) => <InboxItemRow key={item.id} item={item} compact onSelect={handleItemSelect} />)
            ) : (
              <div className="px-4 py-10 text-center">
                <p className="text-13 font-medium text-primary">暂无通知</p>
                <p className="mt-1 text-12 text-tertiary">新的提及、待办和系统提示会显示在这里。</p>
              </div>
            )}
          </div>

          <Link
            href={`/${workspaceSlug}/notifications/`}
            onClick={() => setIsOpen(false)}
            className="flex items-center justify-center border-t border-subtle px-4 py-2.5 text-12 text-secondary transition hover:bg-layer-1-hover hover:text-primary"
          >
            查看全部
          </Link>
        </div>
      )}
    </div>
  );
}
