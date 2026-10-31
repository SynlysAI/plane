// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  markNotificationAsRead: vi.fn(),
}));
vi.mock("@makeplane/propel/icons", () => ({ ClockOutline: () => null, InboxOutline: () => null }));
vi.mock("@plane/propel/avatar", () => ({ Avatar: () => null }));
vi.mock("@plane/ui", () => ({
  Row: (props: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{props.children}</div>,
}));
vi.mock("@plane/utils", () => ({
  cn: (...values: string[]) => values.filter(Boolean).join(" "),
  calculateTimeAgo: () => "刚刚",
  renderFormattedDate: () => "",
  renderFormattedTime: () => "",
  getFileURL: () => "",
}));
vi.mock("@/hooks/store/notifications", () => ({
  useWorkspaceNotifications: () => ({
    currentSelectedNotificationId: null,
    setCurrentSelectedNotificationId: vi.fn(),
  }),
}));
vi.mock("@/hooks/store/notifications/use-notification", () => ({
  useNotification: () => ({ asJson: notification, markNotificationAsRead: mocks.markNotificationAsRead }),
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({ getIsIssuePeeked: () => false, setPeekIssue: vi.fn() }),
}));
vi.mock("@/hooks/store/use-workspace", () => ({
  useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "workspace-1" }) }),
}));
vi.mock("@/components/workspace-notifications/sidebar/notification-card/content", () => ({
  NotificationContent: () => <span>work-item-content</span>,
}));
vi.mock("@/components/workspace-notifications/sidebar/notification-card/options", () => ({
  NotificationOption: () => null,
}));

const notification = {
  id: "notification-1",
  title: "科研链阶段已退回：实验",
  data: {
    chain_name: "新材料课题",
    stage_name: "实验",
    href: "/lab/research/chains/chain-1?tab=nodes&stage=experiment&approval=1",
    issue: undefined,
    issue_activity: {
      id: undefined,
      actor: undefined,
      field: undefined,
      issue_comment: undefined,
      verb: undefined,
      new_value: undefined,
      old_value: undefined,
    },
  },
  announcement_details: undefined,
  entity_name: "research_chain_stage",
  project: "project-1",
  read_at: null,
  triggered_by_details: { id: "advisor", display_name: "王导师", first_name: "王", is_bot: false },
};

const { NotificationItem } = await import("@/components/workspace-notifications/sidebar/notification-card/item");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let locationAssign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  locationAssign = vi.fn();
  vi.stubGlobal("location", { assign: locationAssign });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("renders and opens a research-chain stage notification without issue peek", async () => {
  await act(async () => root.render(<NotificationItem workspaceSlug="lab" notificationId="notification-1" />));

  expect(container.textContent).toContain("科研链阶段已退回：实验");
  expect(container.textContent).toContain("新材料课题 · 实验");
  expect(container.querySelector("work-item-content")).toBeNull();

  const row = container.querySelector(".group");
  await act(async () => row?.click());
  await act(async () => undefined);
  expect(mocks.markNotificationAsRead).toHaveBeenCalledWith("lab");
  expect(locationAssign).toHaveBeenCalledWith("/lab/research/chains/chain-1?tab=nodes&stage=experiment&approval=1");
});
