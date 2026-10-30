import { beforeEach, expect, it, vi } from "vitest";
import { ProfileStore } from "@/store/user/profile.store";
import type { CoreRootStore } from "@/store/root.store";

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("@plane/i18n", () => ({ DEFAULT_LANGUAGE: "zh-CN", setLanguage: vi.fn() }));
vi.mock("@/services/user.service", () => ({
  UserService: class {
    updateCurrentUserProfile = mocks.update;
  },
}));

let profile: ProfileStore;

beforeEach(() => {
  vi.resetAllMocks();
  profile = new ProfileStore({} as CoreRootStore);
  profile.data.theme = {
    theme: "custom",
    primary: "#426b67",
    background: "#f7f7f5",
    darkPalette: false,
    backgroundImage: "/old.jpg",
    contentBackgroundOpacity: 0.85,
  };
});

it("串行合并图片、主题、配色和透明度，后一个请求包含前一个结果", async () => {
  let finish: ((value: unknown) => void) | undefined;
  mocks.update.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  mocks.update.mockImplementation(({ theme }) => Promise.resolve({ theme }));
  const first = profile.updateUserTheme({ contentBackgroundOpacity: 0.6 });
  const second = profile.updateUserTheme({ theme: "dark", backgroundImage: "/new.jpg" });
  const third = profile.updateUserTheme({ primary: "#338866" });
  await Promise.resolve();
  expect(mocks.update).toHaveBeenCalledTimes(1);
  finish?.({ theme: mocks.update.mock.calls[0][0].theme });
  await Promise.all([first, second, third]);
  expect(mocks.update.mock.calls[2][0].theme).toEqual({
    theme: "dark",
    primary: "#338866",
    background: "#f7f7f5",
    darkPalette: false,
    backgroundImage: "/new.jpg",
    contentBackgroundOpacity: 0.6,
  });
  expect(profile.data.theme).toEqual(mocks.update.mock.calls[2][0].theme);
});

it("失败只回滚本次字段，排队中的后续更新仍能保存", async () => {
  mocks.update.mockRejectedValueOnce(new Error("offline"));
  mocks.update.mockImplementation(({ theme }) => Promise.resolve({ theme }));
  const failed = profile.updateUserTheme({ contentBackgroundOpacity: 0.2 });
  const recovered = profile.updateUserTheme({ backgroundImage: null });
  await expect(failed).rejects.toThrow("offline");
  await recovered;
  expect(profile.data.theme.contentBackgroundOpacity).toBe(0.85);
  expect(profile.data.theme.backgroundImage).toBeNull();
  expect(profile.data.theme.primary).toBe("#426b67");
});

it("重新读取个人资料恢复透明度，旧账号无需迁移", async () => {
  mocks.update.mockImplementation(({ theme }) => Promise.resolve({ theme }));
  await profile.updateUserTheme({ contentBackgroundOpacity: 0 });
  const nextSession = new ProfileStore({} as CoreRootStore);
  nextSession.data.theme = mocks.update.mock.calls[0][0].theme;
  expect(nextSession.data.theme.contentBackgroundOpacity).toBe(0);
  await nextSession.updateUserTheme({ theme: "light" });
  expect(nextSession.data.theme.contentBackgroundOpacity).toBe(0);
});
