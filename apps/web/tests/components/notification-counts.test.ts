import { describe, expect, it, vi } from "vitest";

import { ENotificationTab } from "@plane/constants";
import type { TNotification } from "@plane/types";
import {
  adjustUnreadNotificationsCount,
  getNotificationBadgeState,
  isNotificationInTab,
  workspaceUnreadNotificationKey,
} from "@/lib/notification-counts";

const serviceMocks = vi.hoisted(() => ({
  markNotificationAsRead: vi.fn(),
  markNotificationAsUnread: vi.fn(),
  markNotificationAsArchived: vi.fn(),
  markNotificationAsUnArchived: vi.fn(),
  updateNotificationById: vi.fn(),
}));

vi.mock("@/services/workspace-notification.service", () => ({
  default: serviceMocks,
}));

const { Notification: NotificationStore } = await import("@/store/notifications/notification");

function createNotification(overrides: Partial<TNotification>) {
  const setUnreadNotificationsCount = vi.fn();
  const store = {
    workspaceNotification: { setUnreadNotificationsCount },
  } as never;
  const notification = new NotificationStore(store, {
    id: "notification-1",
    is_mentioned_notification: false,
    ...overrides,
  } as TNotification);

  return { notification, setUnreadNotificationsCount };
}

describe("workspace notification count helpers", () => {
  it("uses the total unread count for the badge and mentions only as an indicator", () => {
    expect(
      getNotificationBadgeState({
        total_unread_notifications_count: 5,
        mention_unread_notifications_count: 2,
      })
    ).toEqual({ count: 5, hasMentions: true });
  });

  it("decrements total and mention counts together for a mention", () => {
    expect(
      adjustUnreadNotificationsCount(
        {
          total_unread_notifications_count: 3,
          mention_unread_notifications_count: 2,
        },
        "decrement",
        1,
        true
      )
    ).toEqual({
      total_unread_notifications_count: 2,
      mention_unread_notifications_count: 1,
    });
  });

  it("changes only the total count for an ordinary notification", () => {
    expect(
      adjustUnreadNotificationsCount(
        {
          total_unread_notifications_count: 3,
          mention_unread_notifications_count: 2,
        },
        "increment",
        1,
        false
      )
    ).toEqual({
      total_unread_notifications_count: 4,
      mention_unread_notifications_count: 2,
    });
  });

  it("includes mentions in the all tab and only mentions in the mentions tab", () => {
    const mention = { is_mentioned_notification: true };
    const ordinary = { is_mentioned_notification: false };

    expect(isNotificationInTab(mention, ENotificationTab.ALL)).toBe(true);
    expect(isNotificationInTab(ordinary, ENotificationTab.ALL)).toBe(true);
    expect(isNotificationInTab(mention, ENotificationTab.MENTIONS)).toBe(true);
    expect(isNotificationInTab(ordinary, ENotificationTab.MENTIONS)).toBe(false);
  });

  it("creates a distinct unread-count cache key for each workspace", () => {
    expect(workspaceUnreadNotificationKey("lab")).not.toBe(workspaceUnreadNotificationKey("admin"));
    expect(workspaceUnreadNotificationKey(undefined)).toBeNull();
  });

  it("decrements total and mention counts when a mention is read", async () => {
    serviceMocks.markNotificationAsRead.mockResolvedValueOnce(undefined);
    const { notification, setUnreadNotificationsCount } = createNotification({
      read_at: undefined,
      is_mentioned_notification: true,
    });

    await notification.markNotificationAsRead("lab");

    expect(setUnreadNotificationsCount).toHaveBeenCalledWith("decrement", 1, true);
  });

  it("restores a mention count when marking it read fails", async () => {
    serviceMocks.markNotificationAsRead.mockRejectedValueOnce(new Error("network error"));
    const { notification, setUnreadNotificationsCount } = createNotification({
      read_at: undefined,
      is_mentioned_notification: true,
    });

    await expect(notification.markNotificationAsRead("lab")).rejects.toThrow("network error");

    expect(setUnreadNotificationsCount).toHaveBeenCalledWith("increment", 1, true);
  });

  it("increments only the total count when an ordinary notification is unread", async () => {
    serviceMocks.markNotificationAsUnread.mockResolvedValueOnce(undefined);
    const { notification, setUnreadNotificationsCount } = createNotification({
      read_at: "2026-10-20T00:00:00Z",
      is_mentioned_notification: false,
    });

    await notification.markNotificationAsUnRead("lab");

    expect(setUnreadNotificationsCount).toHaveBeenCalledWith("increment", 1, false);
  });

  it("restores an ordinary count when marking it unread fails", async () => {
    serviceMocks.markNotificationAsUnread.mockRejectedValueOnce(new Error("network error"));
    const { notification, setUnreadNotificationsCount } = createNotification({
      read_at: "2026-10-20T00:00:00Z",
      is_mentioned_notification: false,
    });

    await expect(notification.markNotificationAsUnRead("lab")).rejects.toThrow("network error");

    expect(setUnreadNotificationsCount).toHaveBeenCalledWith("decrement", 1, false);
  });

  it("removes an active unread notification from the count when it is archived", async () => {
    serviceMocks.markNotificationAsArchived.mockResolvedValueOnce(undefined);
    const { notification, setUnreadNotificationsCount } = createNotification({
      read_at: undefined,
      archived_at: undefined,
      snoozed_till: undefined,
    });

    await notification.archiveNotification("lab");

    expect(setUnreadNotificationsCount).toHaveBeenCalledWith("decrement", 1, false);
  });

  it("restores an active unread notification when unarchiving fails", async () => {
    serviceMocks.markNotificationAsUnArchived.mockRejectedValueOnce(new Error("network error"));
    const { notification, setUnreadNotificationsCount } = createNotification({
      read_at: undefined,
      archived_at: "2026-10-19T00:00:00Z",
      snoozed_till: undefined,
    });

    await expect(notification.unArchiveNotification("lab")).rejects.toThrow("network error");

    expect(setUnreadNotificationsCount).toHaveBeenCalledWith("decrement", 1, false);
  });
});
