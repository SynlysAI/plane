// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notificationStore: {
    asJson: {
      id: "notification-1",
      read_at: null,
      project: undefined,
      data: undefined,
      announcement_details: {
        id: "announcement-1",
        title: "版本更新公告",
        body: "新增系统公告收件箱。",
        published_at: "2026-10-23T01:00:00Z",
        created_at: "2026-10-23T01:00:00Z",
        recipient_count: 2,
        delivery_status: "published",
      },
    },
    markNotificationAsRead: vi.fn(),
  },
  workspaceStore: {
    currentSelectedNotificationId: undefined,
    setCurrentSelectedNotificationId: vi.fn(),
  },
  optionProps: {} as { isAnnouncement?: boolean; notificationId?: string },
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@makeplane/propel/icons", () => ({
  ClockOutline: () => <span />,
  InboxOutline: () => <span data-testid="announcement-icon" />,
}));

vi.mock("@makeplane/propel/components/avatar", () => ({
  Avatar: () => <span />,
}));

vi.mock("@plane/ui", () => ({
  Row: ({ children, ...props }: { children: React.ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  ),
}));

vi.mock("@plane/utils", () => ({
  cn: (...classes: string[]) => classes.filter(Boolean).join(" "),
  calculateTimeAgo: () => "just now",
  renderFormattedDate: () => "2026-10-23",
  renderFormattedTime: () => "09:00 AM",
  getFileURL: () => "",
}));

vi.mock("@/hooks/store/notifications/use-notification", () => ({
  useNotification: () => mocks.notificationStore,
}));

vi.mock("@/hooks/store/notifications", () => ({
  useWorkspaceNotifications: () => mocks.workspaceStore,
}));

vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({ getIsIssuePeeked: vi.fn(() => false), setPeekIssue: vi.fn() }),
}));

vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "workspace-1" }) }),
}));

vi.mock("@/components/workspace-notifications/sidebar/notification-card/content", () => ({
  NotificationContent: () => <span>work-item-content</span>,
}));

vi.mock("@/components/workspace-notifications/sidebar/notification-card/options", () => ({
  NotificationItemReadOption: () => <button type="button">read</button>,
  NotificationItemDeleteOption: () => <button type="button">delete</button>,
  NotificationOption: (props: { isAnnouncement: boolean; notificationId: string }) => {
    mocks.optionProps = props;
    return <div data-testid="notification-options" data-announcement={props.isAnnouncement} />;
  },
}));

const { NotificationItem } = await import("@/components/workspace-notifications/sidebar/notification-card/item");
const { SystemAnnouncementDetail } = await import("@/components/workspace-notifications/announcement-detail");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

/** Render one element in a fresh React root. */
async function render(element: React.ReactElement) {
  await act(async () => root.render(element));
}

beforeEach(() => {
  mocks.notificationStore.markNotificationAsRead.mockClear();
  mocks.workspaceStore.setCurrentSelectedNotificationId.mockClear();
  mocks.optionProps = {};
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("系统公告卡片展示标题正文并点击后自动已读", async () => {
  await render(<NotificationItem workspaceSlug="lab" notificationId="notification-1" />);

  expect(container.textContent).toContain("版本更新公告");
  expect(container.textContent).toContain("新增系统公告收件箱。");
  expect(mocks.optionProps).toEqual(expect.objectContaining({ isAnnouncement: true }));

  await act(async () => container.querySelector(".group")?.click());
  expect(mocks.workspaceStore.setCurrentSelectedNotificationId).toHaveBeenCalledWith("notification-1");
  expect(mocks.notificationStore.markNotificationAsRead).toHaveBeenCalledWith("lab");
});

it("公告详情以纯文本展示完整正文和发布信息", async () => {
  await render(<SystemAnnouncementDetail workspaceSlug="lab" notificationId="notification-1" />);

  expect(container.querySelector("article")?.textContent).toContain("版本更新公告");
  expect(container.querySelector("article")?.textContent).toContain("新增系统公告收件箱。");
  expect(container.querySelector("article")?.innerHTML).toContain("whitespace-pre-wrap");
  expect(container.querySelectorAll("button")).toHaveLength(2);
});
