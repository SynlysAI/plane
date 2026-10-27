// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const callbacks = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  setSelfSubscribed: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      return typeof value === "string" ? value : key;
    },
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, disabled, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("@plane/ui", () => ({
  EModalPosition: { CENTER: "center" },
  EModalWidth: { XXXL: "xxxl" },
  ModalCore: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div data-modal="">{children}</div> : null,
}));
vi.mock("@makeplane/propel/components/avatar", () => ({
  Avatar: ({ fallback }: { fallback: string }) => <span>{fallback}</span>,
}));
vi.mock("@/components/common/avatar-group-overflow", () => ({
  AvatarGroupOverflow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@plane/utils", () => ({
  cn: (...values: string[]) => values.filter(Boolean).join(" "),
  getFileURL: (value: string) => value,
}));

const payload = {
  schema_version: "task-notification-recipients.v1" as const,
  groups: [
    { id: "research", name: "导师组" },
    { id: "office", name: "行政团队" },
  ],
  candidates: [
    {
      id: "fixed-user",
      display_name: "李同学",
      email: "student@example.com",
      avatar_url: null,
      group_ids: ["research"],
    },
    {
      id: "cc-user",
      display_name: "王老师",
      email: "teacher@example.com",
      avatar_url: null,
      group_ids: ["research"],
    },
    {
      id: "office-user",
      display_name: "张老师",
      email: "office@example.com",
      avatar_url: null,
      group_ids: ["office"],
    },
  ],
  selected_user_ids: ["fixed-user"],
  cc_user_ids: [],
  fixed_user_ids: ["fixed-user"],
  recipient_user_ids: ["fixed-user"],
  current_user_subscribed: false,
  current_user_self_subscribed: false,
  can_manage: true,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  callbacks.load.mockResolvedValue(payload);
  callbacks.save.mockResolvedValue(payload);
  callbacks.setSelfSubscribed.mockResolvedValue({
    ...payload,
    current_user_subscribed: true,
    current_user_self_subscribed: true,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderFooter() {
  const { TaskNotificationRecipients } = await import("@/components/common/task-notification-recipients");
  await act(async () => {
    root.render(
      <TaskNotificationRecipients
        load={callbacks.load}
        save={callbacks.save}
        setSelfSubscribed={callbacks.setSelfSubscribed}
      />
    );
  });
  await act(async () => undefined);
}

function button(label: string) {
  const target = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === label
  );
  if (!target) throw new Error(`button ${label} not found`);
  return target;
}

it("loads recipients, filters groups and searches members before saving carbon copies", async () => {
  await renderFooter();
  expect(callbacks.load).toHaveBeenCalledExactlyOnceWith();
  expect(container.querySelector("[data-task-notification-recipients]")?.textContent).toContain("这些人会收到通知");

  await act(async () => button("编辑通知列表").click());
  expect(container.querySelector('[data-modal=""]')?.textContent).toContain("编辑通知成员");

  await act(async () => button("导师组").click());
  expect(container.querySelector('[data-modal=""]')?.textContent).not.toContain("张老师");

  const search = container.querySelector<HTMLInputElement>('input[type="search"]');
  if (!search) throw new Error("search input not found");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(search, "王");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector('[data-modal=""]')?.textContent).not.toContain("李同学");

  const option = container.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)');
  if (!option) throw new Error("selectable checkbox not found");
  await act(async () => option.click());
  await act(async () => button("保存").click());
  expect(callbacks.save).toHaveBeenCalledExactlyOnceWith(["fixed-user", "cc-user"]);
  expect(container.querySelector('[data-modal=""]')).toBeNull();
});

it("keeps fixed members selected and disables their checkbox", async () => {
  await renderFooter();
  await act(async () => button("编辑通知列表").click());
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!checkbox) throw new Error("checkbox not found");
  expect(checkbox.checked).toBe(true);
  expect(checkbox.disabled).toBe(true);
});

it("keeps the editor unavailable when the server denies management", async () => {
  callbacks.load.mockResolvedValue({ ...payload, can_manage: false });
  await renderFooter();
  expect(button("编辑通知列表").disabled).toBe(true);
});

it("toggles the current user's self subscription independently", async () => {
  await renderFooter();
  await act(async () => button("有新动态通知我").click());
  expect(callbacks.setSelfSubscribed).toHaveBeenCalledExactlyOnceWith(true);
  expect(button("停止通知我")).toBeTruthy();
});

it("shows a recoverable loading failure", async () => {
  callbacks.load.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(payload);
  await renderFooter();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("通知成员加载失败");
  await act(async () => button("重试").click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
