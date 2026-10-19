// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IUser, TUserProfile } from "@plane/types";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({ updateCurrentUser: vi.fn(), updateUserProfile: vi.fn() }));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: {}, updateCurrentUser: mocks.updateCurrentUser }),
  useUserProfile: () => ({ updateUserProfile: mocks.updateUserProfile }),
}));
vi.mock("@/hooks/store/use-instance", () => ({ useInstance: () => ({ config: {} }) }));
vi.mock("@plane/i18n", () => ({
  DEFAULT_LANGUAGE: "zh-CN",
  useTranslation: () => ({
    /** 使用项目中文文案，替换本表单使用的实体占位符。 */
    t: (key: string, params?: Record<string, string>) => {
      const value = key
        .split(".")
        .reduce<unknown>((current, part) => (current as Record<string, unknown>)?.[part], translations);
      return String(value ?? key).replace(/\{(\w+)\}/g, (_, name: string) => params?.[name] ?? name);
    },
  }),
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "success", ERROR: "error" },
  setToast: vi.fn(),
  setPromiseToast: vi.fn(),
}));
vi.mock("@/components/account/deactivate-account-modal", () => ({ DeactivateAccountModal: () => null }));
vi.mock("@/components/core/image-picker-popover", () => ({ ImagePickerPopover: () => null }));
vi.mock("@/components/core/modals/change-email-modal", () => ({ ChangeEmailModal: () => null }));
vi.mock("@/components/core/modals/user-image-upload-modal", () => ({ UserImageUploadModal: () => null }));
vi.mock("@/helpers/cover-image.helper", () => ({
  handleCoverImageChange: vi.fn().mockResolvedValue(undefined),
  DEFAULT_COVER_IMAGE_URL: "",
  getCoverImageDisplayURL: () => "",
}));

const { GeneralProfileSettingsForm } = await import("@/components/settings/profile/content/pages/general/form");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateCurrentUser.mockResolvedValue({ id: "user" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** 挂载真实表单，其他必填字段使用有效值以隔离姓氏校验。 */
async function renderForm(lastName = "") {
  const user = {
    id: "user",
    first_name: "晟珏",
    last_name: lastName,
    display_name: "庄晟珏",
    email: "member@example.com",
  } as IUser;
  await act(async () =>
    root.render(<GeneralProfileSettingsForm user={user} profile={{ role: "Researcher" } as TUserProfile} />)
  );
}

/** 触发表单提交，等待真实 react-hook-form 校验与保存完成。 */
async function submit() {
  await act(async () => {
    container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/** 通过输入事件修改姓氏，覆盖校验失败后的重新编辑流程。 */
async function enterLastName(value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>("#last_name")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("显示姓氏必填星号并向辅助技术声明必填", async () => {
  await renderForm();
  const input = container.querySelector<HTMLInputElement>("#last_name")!;
  const heading = Array.from(container.querySelectorAll("h4")).find((element) =>
    element.textContent?.startsWith("姓")
  )!;
  expect(heading.textContent).toMatch(/姓\s*\*/);
  expect(heading.querySelector(".text-danger-primary")?.textContent).toBe("*");
  expect(input.getAttribute("aria-required")).toBe("true");
});

it.each(["", " \t "])("姓氏为 %j 时显示中文必填提示并阻止保存", async (lastName) => {
  await renderForm(lastName);
  await submit();
  expect(container.textContent).toContain("姓为必填项");
  expect(mocks.updateCurrentUser).not.toHaveBeenCalled();
  expect(mocks.updateUserProfile).not.toHaveBeenCalled();
});

it.each(["庄", "Zhuang"])("补填有效姓氏 %s 后清除错误并允许保存", async (lastName) => {
  await renderForm();
  await submit();
  await enterLastName(lastName);
  await submit();
  expect(container.textContent).not.toContain("姓为必填项");
  expect(mocks.updateCurrentUser).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ last_name: lastName }));
});

it.each([
  ["庄<script>", "Names cannot contain special characters"],
  ["庄".repeat(51), "Name must be 50 characters or less"],
])("保留姓氏 %s 的格式与长度校验", async (lastName, message) => {
  await renderForm(lastName);
  await submit();
  expect(container.textContent).toContain(message);
  expect(mocks.updateCurrentUser).not.toHaveBeenCalled();
});
