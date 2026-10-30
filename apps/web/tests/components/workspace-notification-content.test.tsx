// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import zh from "../../../../packages/i18n/src/locales/zh-CN/common.json";
import en from "../../../../packages/i18n/src/locales/en/common.json";

const mocks = vi.hoisted(() => ({ locale: "zh-CN" }));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const source = mocks.locale === "zh-CN" ? zh : en;
      const value = key.split(".").reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], source);
      return typeof value === "string" ? value : key;
    },
  }),
}));
vi.mock("@plane/utils", () => ({
  renderFormattedDate: (value: string | undefined) => value ?? "",
  sanitizeCommentForNotification: (value: string | undefined) => value ?? "",
  stripAndTruncateHTML: (value: string | undefined) => value ?? "",
}));
vi.mock("@/components/editor/lite-text", () => ({ LiteTextEditor: () => null }));

const { NotificationContent } = await import("@/components/workspace-notifications/sidebar/notification-card/content");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.locale = "zh-CN";
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function notification(field: string, newValue?: string, verb = "updated") {
  return {
    id: "notification-1",
    title: "工作项更新",
    data: {
      issue: { id: "issue-1", identifier: "LAB", sequence_id: 1, name: "材料实验" },
      issue_activity: {
        id: "activity-1",
        actor: "user-1",
        field,
        issue_comment: undefined,
        verb: verb as "updated",
        new_value: newValue,
        old_value: undefined,
      },
    },
    triggered_by_details: {
      id: "user-1",
      display_name: "李老师",
      first_name: "李",
      is_bot: false,
    },
  };
}

async function renderContent(field: string, value?: string) {
  await act(async () => {
    root.render(
      <NotificationContent
        notification={notification(field, value) as never}
        workspaceId="workspace-1"
        workspaceSlug="lab"
        projectId="project-1"
      />
    );
  });
}

it("renders work-item assignee and state actions through zh-CN locale keys", async () => {
  await renderContent("assignees", "张三");
  expect(container.textContent).toContain("李老师 添加了负责人 张三");
  expect(container.textContent).not.toContain("added assignee");

  await renderContent("state", "进行中");
  expect(container.textContent).toContain("李老师 更新状态 为 进行中");
});

it("renders the same actions through en locale keys", async () => {
  mocks.locale = "en";
  await renderContent("assignees", "Zhang San");
  expect(container.textContent).toContain("李老师 added assignee Zhang San");
});
