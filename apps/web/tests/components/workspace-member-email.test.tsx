// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { updateMemberEmail, setToast } = vi.hoisted(() => ({
  updateMemberEmail: vi.fn(),
  setToast: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@headlessui/react", () => ({ Disclosure: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@plane/constants", () => ({ ROLE: {}, EUserPermissions: {}, EUserPermissionsLevel: {} }));
vi.mock("@makeplane/propel/icons", () => ({
  DeactivatedUserOutline: () => <span />,
  DeleteOutline: () => <span />,
  EditOutline: () => <span />,
}));
vi.mock("@plane/propel/pill", () => ({ Pill: () => null, EPillVariant: {}, EPillSize: {} }));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "success", ERROR: "error" },
  setToast,
}));
vi.mock("@plane/ui", () => ({ CustomSelect: () => null, PopoverMenu: () => null }));
vi.mock("@plane/utils", () => ({ getFileURL: (value: string) => value }));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({ workspace: { updateMemberEmail } }),
}));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: undefined }), useUserPermissions: () => ({}) }));

const { EmailColumn } = await import("@/components/workspace/settings/member-columns");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

/** 创建邮箱列所需的最小成员数据。
 *
 * @param overrides 用于覆盖默认字段的成员数据。
 * @returns 邮箱列所需的工作区成员行。
 */
function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    member: {
      id: "member-1",
      email: "old@example.com",
      is_bot: false,
    },
    role: 15,
    is_active: true,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  updateMemberEmail.mockReset();
  setToast.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** 使用指定权限和成员数据渲染邮箱列。
 *
 * @param isAdmin 当前操作者是否为工作区管理员。
 * @param rowData 要显示的工作区成员。
 */
async function renderEmailColumn(isAdmin: boolean, rowData = memberRow()) {
  await act(async () => root.render(<EmailColumn rowData={rowData as never} workspaceSlug="lab" isAdmin={isAdmin} />));
}

/** 打开成员邮箱行内编辑器。 */
async function openEditor() {
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="修改邮箱"]')?.click());
}

/** 在受控邮箱输入框中设置输入值。
 *
 * @param email 要输入的新邮箱地址。
 */
async function enterEmail(email: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="修正邮箱"]');
  if (!input) throw new Error("Email editor is not open");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, email);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("shows the edit entry only for administrators and active human members", async () => {
  await renderEmailColumn(false);
  expect(container.querySelector('[aria-label="修改邮箱"]')).toBeNull();

  await renderEmailColumn(true, memberRow({ is_active: false }));
  expect(container.querySelector('[aria-label="修改邮箱"]')).toBeNull();

  await renderEmailColumn(true, memberRow({ member: { id: "bot", email: "bot@example.com", is_bot: true } }));
  expect(container.querySelector('[aria-label="修改邮箱"]')).toBeNull();

  await renderEmailColumn(true);
  expect(container.querySelector('[aria-label="修改邮箱"]')).not.toBeNull();
});

it("saves the corrected email and reports success", async () => {
  updateMemberEmail.mockResolvedValue("new@example.com");
  await renderEmailColumn(true);
  await openEditor();
  await enterEmail("new@example.com");

  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="保存邮箱"]')?.click());

  expect(updateMemberEmail).toHaveBeenCalledWith("lab", "member-1", "new@example.com");
  expect(container.querySelector('[aria-label="修正邮箱"]')).toBeNull();
  expect(setToast).toHaveBeenCalledWith(expect.objectContaining({ type: "success", title: "邮箱已更新" }));
});

it("cancels edits and handles Escape without submitting", async () => {
  await renderEmailColumn(true);
  await openEditor();
  await enterEmail("unsaved@example.com");

  await act(async () => {
    container
      .querySelector<HTMLInputElement>('[aria-label="修正邮箱"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  expect(container.querySelector('[aria-label="修正邮箱"]')).toBeNull();
  expect(updateMemberEmail).not.toHaveBeenCalled();

  await openEditor();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="取消编辑邮箱"]')?.click());
  expect(container.querySelector('[aria-label="修正邮箱"]')).toBeNull();

  await openEditor();
  const editor = container.querySelector('[aria-label="修正邮箱"]')?.parentElement;
  const saveButton = container.querySelector<HTMLButtonElement>('[aria-label="保存邮箱"]');
  await act(async () => {
    editor?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: saveButton }));
  });
  expect(container.querySelector('[aria-label="修正邮箱"]')).not.toBeNull();

  await act(async () => {
    saveButton?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  });
  expect(container.querySelector('[aria-label="修正邮箱"]')).toBeNull();

  await openEditor();
  await act(async () => {
    container
      .querySelector<HTMLInputElement>('[aria-label="修正邮箱"]')
      ?.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
  });
  expect(container.querySelector('[aria-label="修正邮箱"]')).toBeNull();
});

it("saves on Enter", async () => {
  updateMemberEmail.mockResolvedValue("enter@example.com");
  await renderEmailColumn(true);
  await openEditor();
  await enterEmail("enter@example.com");

  await act(async () => {
    container
      .querySelector<HTMLInputElement>('[aria-label="修正邮箱"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });

  expect(updateMemberEmail).toHaveBeenCalledWith("lab", "member-1", "enter@example.com");
});

it("keeps the editor open and reports server errors", async () => {
  updateMemberEmail.mockRejectedValue({ error: "该邮箱已被其他账号使用。" });
  await renderEmailColumn(true);
  await openEditor();
  await enterEmail("used@example.com");

  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="保存邮箱"]')?.click());

  expect(container.querySelector('[aria-label="修正邮箱"]')).not.toBeNull();
  expect(setToast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", title: "邮箱更新失败", message: "该邮箱已被其他账号使用。" })
  );
});
