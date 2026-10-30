// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EFileAssetType } from "@plane/types";
import { ThemeStore } from "@/store/theme.store";

const mocks = vi.hoisted(() => ({
  updateUserTheme: vi.fn(),
  uploadUserAsset: vi.fn(),
  deleteUserAsset: vi.fn(),
  setToast: vi.fn(),
}));

const state = {
  appTheme: new ThemeStore(),
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
vi.mock("@plane/propel/tooltip", () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@/hooks/store/use-app-theme", () => ({ useAppTheme: () => state.appTheme }));
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
  state.appTheme = new ThemeStore();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** 通过原生输入事件模拟范围控件，绕过 React 的值追踪器。 */
async function changeTransparency(value: number) {
  const input = container.querySelector<HTMLInputElement>('input[type="range"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("历史账号默认显示 15%，未设置图片时禁用控件", async () => {
  await act(async () => root.render(<WorkspaceBackgroundSettings />));
  const input = container.querySelector<HTMLInputElement>('input[type="range"]')!;
  expect(input.value).toBe("15");
  expect(input.disabled).toBe(true);
});

it.each([0, 100])("透明度 %i%% 支持即时预览，并在键盘空闲后只保存一次", async (value) => {
  vi.useFakeTimers();
  state.profile.theme.backgroundImage = "/background.jpg";
  await act(async () => root.render(<WorkspaceBackgroundSettings />));
  await changeTransparency(value);
  expect(state.appTheme.contentBackgroundOpacityPreview).toBe((100 - value) / 100);
  expect(mocks.updateUserTheme).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(299));
  expect(mocks.updateUserTheme).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(mocks.updateUserTheme).toHaveBeenCalledExactlyOnceWith({ contentBackgroundOpacity: (100 - value) / 100 });
  expect(state.appTheme.contentBackgroundOpacityPreview).toBeUndefined();
});

it("失焦提交最终值，并取消键盘延迟任务", async () => {
  vi.useFakeTimers();
  state.profile.theme.backgroundImage = "/background.jpg";
  await act(async () => root.render(<WorkspaceBackgroundSettings />));
  await changeTransparency(25);
  await changeTransparency(40);
  await act(async () => {
    container.querySelector('input[type="range"]')!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(mocks.updateUserTheme).toHaveBeenCalledExactlyOnceWith({ contentBackgroundOpacity: 0.6 });
});

it("指针拖动保持预览，松手后保存且不重复响应失焦", async () => {
  vi.useFakeTimers();
  state.profile.theme.backgroundImage = "/background.jpg";
  await act(async () => root.render(<WorkspaceBackgroundSettings />));
  const input = container.querySelector<HTMLInputElement>('input[type="range"]')!;
  input.setPointerCapture = vi.fn();
  await act(async () => input.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  await changeTransparency(30);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(mocks.updateUserTheme).not.toHaveBeenCalled();
  await act(async () => {
    input.dispatchEvent(new Event("pointerup", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  expect(mocks.updateUserTheme).toHaveBeenCalledExactlyOnceWith({ contentBackgroundOpacity: 0.7 });
});

it("拖动中失焦会结束指针状态，后续键盘调整仍按 300 毫秒提交", async () => {
  vi.useFakeTimers();
  state.profile.theme.backgroundImage = "/background.jpg";
  await act(async () => root.render(<WorkspaceBackgroundSettings />));
  const input = container.querySelector<HTMLInputElement>('input[type="range"]')!;
  input.setPointerCapture = vi.fn();
  await act(async () => input.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  await changeTransparency(30);
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  expect(mocks.updateUserTheme).toHaveBeenCalledTimes(1);
  await changeTransparency(40);
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(mocks.updateUserTheme).toHaveBeenCalledTimes(2);
  expect(mocks.updateUserTheme).toHaveBeenLastCalledWith({ contentBackgroundOpacity: 0.6 });
});

it("保存期间禁用滑块，失败后恢复原值并提示", async () => {
  state.profile.theme.backgroundImage = "/background.jpg";
  state.profile.theme.contentBackgroundOpacity = 0.65;
  let reject: ((error: Error) => void) | undefined;
  mocks.updateUserTheme.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      })
  );
  await act(async () => root.render(<WorkspaceBackgroundSettings />));
  await changeTransparency(50);
  await act(async () => {
    container.querySelector('input[type="range"]')!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  expect(container.querySelector<HTMLInputElement>('input[type="range"]')!.disabled).toBe(true);
  await act(async () => reject?.(new Error("offline")));
  await act(async () => root.render(<WorkspaceBackgroundSettings />));
  expect(container.querySelector<HTMLInputElement>('input[type="range"]')!.value).toBe("35");
  expect(state.appTheme.contentBackgroundOpacityPreview).toBeUndefined();
  expect(mocks.setToast).toHaveBeenCalledWith(
    expect.objectContaining({ message: "failed_to_update_workspace_background_opacity" })
  );
});

it("重置恢复 15%，卸载时清除未提交预览和延迟任务", async () => {
  vi.useFakeTimers();
  state.profile.theme.backgroundImage = "/background.jpg";
  state.profile.theme.contentBackgroundOpacity = 0.4;
  await act(async () => root.render(<WorkspaceBackgroundSettings />));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[aria-label="workspace_background_opacity_reset"]')!.click()
  );
  expect(mocks.updateUserTheme).toHaveBeenCalledExactlyOnceWith({ contentBackgroundOpacity: 0.85 });
  await changeTransparency(50);
  await act(async () => root.render(<div />));
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(state.appTheme.contentBackgroundOpacityPreview).toBeUndefined();
  expect(mocks.updateUserTheme).toHaveBeenCalledTimes(1);
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
