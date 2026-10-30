// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EFileAssetType } from "@plane/types";

const mocks = vi.hoisted(() => ({
  updateUserTheme: vi.fn(),
  uploadUserAsset: vi.fn(),
  deleteUserAsset: vi.fn(),
  setToast: vi.fn(),
}));

const state = {
  profile: {
    id: "profile",
    theme: {
      theme: "dark",
      primary: "#3f76ff",
      background: "#1a1a1a",
      darkPalette: true,
      backgroundImage: null,
    },
  } as any,
};

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/propel/button", () => ({
  Button: ({ loading: _loading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "success", ERROR: "error" },
  setToast: mocks.setToast,
}));
vi.mock("@/hooks/store/user", () => ({
  useUserProfile: () => ({ data: state.profile, updateUserTheme: mocks.updateUserTheme }),
}));
vi.mock("@/services/file.service", () => ({
  FileService: class {
    uploadUserAsset = mocks.uploadUserAsset;
    deleteUserAsset = mocks.deleteUserAsset;
  },
}));

const { WorkspaceBackgroundSettings } =
  await import("@/components/settings/profile/content/pages/preferences/background-settings");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  state.profile = {
    id: "profile",
    theme: { theme: "dark", primary: "#3f76ff", background: "#1a1a1a", darkPalette: true, backgroundImage: null },
  };
  mocks.updateUserTheme.mockResolvedValue({});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** 构造可覆盖 size 属性的测试图片文件。 */
function makeImage(name: string, type: string, size = 1024) {
  const file = new File(["image"], name, { type });
  Object.defineProperty(file, "size", { configurable: true, value: size });
  return file;
}

it("选择内置背景时保存个人偏好", async () => {
  await act(async () => root.render(<WorkspaceBackgroundSettings />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="background-option-0"]')?.click());
  expect(mocks.updateUserTheme).toHaveBeenCalledWith({ backgroundImage: expect.any(String) });
});

it("上传背景使用独立的用户背景资产类型", async () => {
  const file = new File(["image"], "wallpaper.png", { type: "image/png" });
  mocks.uploadUserAsset.mockResolvedValue({
    asset_id: "new-asset",
    asset_url: "/api/assets/v2/static/new-asset/",
  });
  await act(async () => root.render(<WorkspaceBackgroundSettings />));
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });

  expect(mocks.uploadUserAsset).toHaveBeenCalledWith(
    { entity_identifier: "", entity_type: EFileAssetType.USER_BACKGROUND },
    file
  );
  expect(mocks.updateUserTheme).toHaveBeenCalledWith({ backgroundImage: "/api/assets/v2/static/new-asset/" });
});

it("移除背景时先保存偏好再清理旧资产", async () => {
  state.profile.theme.backgroundImage = "/api/assets/v2/static/old-asset/";
  mocks.deleteUserAsset.mockResolvedValue(undefined);
  await act(async () => root.render(<WorkspaceBackgroundSettings />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="remove-background"]')?.click());

  expect(mocks.updateUserTheme).toHaveBeenCalledWith({ backgroundImage: null });
  expect(mocks.deleteUserAsset).toHaveBeenCalledWith("old-asset");
});

it("blocks an unsupported background image type", async () => {
  await act(async () => root.render(<WorkspaceBackgroundSettings />));
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  const file = makeImage("wallpaper.txt", "text/plain");
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });

  expect(mocks.uploadUserAsset).not.toHaveBeenCalled();
  expect(mocks.updateUserTheme).not.toHaveBeenCalled();
  expect(mocks.setToast).toHaveBeenCalledWith(
    expect.objectContaining({ message: "workspace_background_invalid_type" })
  );
});

it("blocks a background image larger than five megabytes", async () => {
  await act(async () => root.render(<WorkspaceBackgroundSettings />));
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  const file = makeImage("wallpaper.png", "image/png", 5 * 1024 * 1024 + 1);
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
  });

  expect(mocks.uploadUserAsset).not.toHaveBeenCalled();
  expect(mocks.updateUserTheme).not.toHaveBeenCalled();
  expect(mocks.setToast).toHaveBeenCalledWith(
    expect.objectContaining({ message: "workspace_background_file_too_large" })
  );
});
