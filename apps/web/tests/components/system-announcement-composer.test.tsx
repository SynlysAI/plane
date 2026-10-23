// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  store: {
    systemAnnouncements: [],
    systemAnnouncementLoader: undefined,
    systemAnnouncementError: false,
    getSystemAnnouncements: vi.fn(),
    publishSystemAnnouncement: vi.fn(),
  },
  toast: vi.fn(),
}));

vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({ allowPermissions: () => mocks.isAdmin }),
}));

vi.mock("@/hooks/store/notifications", () => ({
  useWorkspaceNotifications: () => mocks.store,
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options && "count" in options ? `${key}:${options.count}` : key),
  }),
}));

vi.mock("@makeplane/propel/icons", () => ({
  EditOutline: () => <span data-testid="compose-icon" />,
}));

vi.mock("@makeplane/propel/components/field", () => ({
  Field: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@makeplane/propel/components/input", () => ({
  InputGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@makeplane/propel/components/text-area", () => ({
  TextAreaGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TextArea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));

vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "success", ERROR: "error" },
  setToast: (...args: unknown[]) => mocks.toast(...args),
}));

vi.mock("@plane/ui", () => ({
  EModalPosition: { TOP: "top" },
  EModalWidth: { XXL: "xxl" },
  ModalCore: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div data-testid="announcement-modal">{children}</div> : null,
  AlertModalCore: ({
    children,
    handleSubmit,
    isSubmitting,
  }: {
    children: React.ReactNode;
    handleSubmit: () => void;
    isSubmitting: boolean;
  }) => (
    <button type="button" data-testid="publish-confirm" onClick={handleSubmit} disabled={isSubmitting}>
      {children}
    </button>
  ),
}));

vi.mock("@plane/utils", () => ({ calculateTimeAgo: () => "just now" }));

const { SystemAnnouncementComposer } = await import("@/components/workspace-notifications/announcement-composer");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

/** Render the announcement composer in an isolated DOM root. */
async function renderComposer() {
  await act(async () => root.render(<SystemAnnouncementComposer workspaceSlug="lab" />));
}

/** Find a button by its visible text. */
function button(text: string) {
  return Array.from(container.querySelectorAll("button")).find((element) => element.textContent?.includes(text));
}

/** Set a controlled input value and trigger React's change event. */
function setInputValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  valueSetter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  Object.assign(mocks.store, {
    systemAnnouncements: [],
    systemAnnouncementLoader: undefined,
    systemAnnouncementError: false,
    getSystemAnnouncements: vi.fn().mockResolvedValue(undefined),
    publishSystemAnnouncement: vi.fn(),
  });
  mocks.isAdmin = true;
  mocks.toast.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("普通用户看不到发布公告入口", async () => {
  mocks.isAdmin = false;
  await renderComposer();

  expect(container.textContent).not.toContain("notification.announcement.compose");
  expect(mocks.store.getSystemAnnouncements).not.toHaveBeenCalled();
});

it("管理员完成预览、二次确认并携带幂等键发布", async () => {
  mocks.store.publishSystemAnnouncement.mockResolvedValueOnce({
    id: "announcement-1",
    recipient_count: 3,
  });
  await renderComposer();

  await act(async () => button("notification.announcement.compose")?.click());
  await act(async () => {
    const title = document.querySelector<HTMLInputElement>("#announcement-title");
    const body = document.querySelector<HTMLTextAreaElement>("#announcement-body");
    if (title) setInputValue(title, "版本更新");
    if (body) setInputValue(body, "系统公告正文");
  });
  await act(async () => button("notification.announcement.preview")?.click());
  expect(container.textContent).toContain("版本更新");
  expect(container.textContent).toContain("系统公告正文");

  await act(async () => button("notification.announcement.publish")?.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="publish-confirm"]')?.click());

  expect(mocks.store.publishSystemAnnouncement).toHaveBeenCalledWith("lab", {
    title: "版本更新",
    body: "系统公告正文",
    idempotency_key: expect.stringMatching(/.+/),
  });
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "success", message: "notification.announcement.toasts.published_count:3" })
  );
});

it("发布失败时保留草稿并显示错误反馈", async () => {
  mocks.store.publishSystemAnnouncement.mockRejectedValueOnce(new Error("network error"));
  await renderComposer();

  await act(async () => button("notification.announcement.compose")?.click());
  await act(async () => {
    const title = document.querySelector<HTMLInputElement>("#announcement-title");
    const body = document.querySelector<HTMLTextAreaElement>("#announcement-body");
    if (title) setInputValue(title, "维护公告");
    if (body) setInputValue(body, "今晚维护");
  });
  await act(async () => button("notification.announcement.preview")?.click());
  await act(async () => button("notification.announcement.publish")?.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="publish-confirm"]')?.click());

  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  expect(container.textContent).toContain("维护公告");
  expect(container.textContent).toContain("今晚维护");
});
