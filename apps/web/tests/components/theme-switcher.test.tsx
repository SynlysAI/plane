// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateUserTheme: vi.fn(),
  setTheme: vi.fn(),
  applyCustomTheme: vi.fn(),
  clearCustomTheme: vi.fn(),
  setPromiseToast: vi.fn(),
  reload: vi.fn(),
}));

const state = {
  profile: {
    id: "profile",
    theme: {
      theme: "dark",
      primary: undefined,
      background: undefined,
      darkPalette: undefined,
      backgroundImage: undefined,
    },
  } as any,
  resolvedTheme: "dark",
};

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme: state.resolvedTheme, setTheme: mocks.setTheme }),
}));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/propel/toast", () => ({ setPromiseToast: mocks.setPromiseToast }));
vi.mock("@plane/utils", () => ({
  applyCustomTheme: mocks.applyCustomTheme,
  clearCustomTheme: mocks.clearCustomTheme,
}));
vi.mock("@/hooks/store/user", () => ({
  useUserProfile: () => ({ data: state.profile, updateUserTheme: mocks.updateUserTheme }),
}));
vi.mock("@/components/core/theme/theme-switch", () => ({
  ThemeSwitch: ({ onChange }: { onChange: (value: { value: string }) => void }) => (
    <div>
      {["light", "custom"].map((value) => (
        <button key={value} type="button" data-testid={`select-${value}`} onClick={() => onChange({ value })}>
          {value}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("@/components/core/theme/custom-theme-selector", () => ({ CustomThemeSelector: () => null }));

const { ThemeSwitcher } = await import("@/components/appearance/theme-switcher");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  state.profile = {
    id: "profile",
    theme: { theme: "dark", primary: undefined, background: undefined, darkPalette: undefined, backgroundImage: null },
  };
  state.resolvedTheme = "dark";
  vi.stubGlobal("location", { reload: mocks.reload });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function click(testId: string) {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)?.click();
    await Promise.resolve();
  });
}

it("首次选择自定义主题时保存完整深色默认配置且不刷新", async () => {
  mocks.updateUserTheme.mockResolvedValue({});
  await act(async () =>
    root.render(<ThemeSwitcher option={{ id: "theme", title: "theme", description: "description" }} />)
  );
  await click("select-custom");

  expect(mocks.updateUserTheme).toHaveBeenCalledWith({
    theme: "custom",
    primary: "#3f76ff",
    background: "#1a1a1a",
    darkPalette: true,
  });
  expect(mocks.setTheme).toHaveBeenCalledWith("custom");
  expect(mocks.applyCustomTheme).toHaveBeenCalledWith("#3f76ff", "#1a1a1a", "dark");
  expect(mocks.reload).not.toHaveBeenCalled();
});

it("切回内置主题时清除自定义变量并保留用户配置", async () => {
  state.profile.theme = {
    theme: "custom",
    primary: "#426b67",
    background: "#f7f7f5",
    darkPalette: false,
    backgroundImage: "/api/assets/v2/static/old/",
  };
  mocks.updateUserTheme.mockResolvedValue({});
  await act(async () =>
    root.render(<ThemeSwitcher option={{ id: "theme", title: "theme", description: "description" }} />)
  );
  await click("select-light");

  expect(mocks.updateUserTheme).toHaveBeenCalledWith({ theme: "light" });
  expect(mocks.clearCustomTheme).toHaveBeenCalledTimes(1);
  expect(state.profile.theme.primary).toBe("#426b67");
  expect(state.profile.theme.backgroundImage).toBe("/api/assets/v2/static/old/");
  expect(mocks.reload).not.toHaveBeenCalled();
});

it("保存失败时不提前改变视觉主题", async () => {
  mocks.updateUserTheme.mockRejectedValue(new Error("offline"));
  await act(async () =>
    root.render(<ThemeSwitcher option={{ id: "theme", title: "theme", description: "description" }} />)
  );
  await click("select-custom");

  expect(mocks.setTheme).not.toHaveBeenCalled();
  expect(mocks.applyCustomTheme).not.toHaveBeenCalled();
  expect(mocks.reload).not.toHaveBeenCalled();
});
