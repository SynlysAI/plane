// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateUserTheme: vi.fn(),
  setToast: vi.fn(),
  reload: vi.fn(),
}));

const profile = {
  id: "profile",
  theme: {
    theme: "custom",
    primary: "#426b67",
    background: "#1a1a1a",
    darkPalette: true,
    contentBackgroundOpacity: undefined as number | undefined,
  },
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
vi.mock("@plane/utils", () => ({ applyCustomTheme: vi.fn(), isColorDark: (value: string) => value === "#1a1a1a" }));
vi.mock("@/hooks/store/user", () => ({
  useUserProfile: () => ({
    data: profile,
    updateUserTheme: mocks.updateUserTheme,
  }),
}));
vi.mock("@/components/settings/profile/heading", () => ({
  ProfileSettingsHeading: ({ control }: { control: React.ReactNode }) => <div>{control}</div>,
}));
vi.mock("@/components/core/theme/import-config-button", () => ({
  CustomThemeImportConfigButton: () => <button type="button">import</button>,
}));
vi.mock("@/components/core/theme/download-config-button", () => ({
  CustomThemeDownloadConfigButton: () => <button type="button">download</button>,
}));
vi.mock("@plane/ui", () => ({
  InputColorPicker: ({
    name,
    value,
    onChange,
    hasError,
  }: {
    name: string;
    value?: string;
    onChange: (value: string) => void;
    hasError: boolean;
  }) => (
    <input
      aria-label={name}
      value={value ?? ""}
      data-invalid={hasError}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const { CustomThemeSelector } = await import("@/components/core/theme/custom-theme-selector");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateUserTheme.mockResolvedValue({});
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

async function changeColor(label: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`);
  if (!input) throw new Error(`${label} 输入框不存在`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("背景透明度更新不会清除尚未保存的自定义配色", async () => {
  await act(async () => root.render(<CustomThemeSelector />));
  await changeColor("primary", "#335566");
  profile.theme = { ...profile.theme, contentBackgroundOpacity: 0.5 };
  await act(async () => root.render(<CustomThemeSelector />));
  expect(container.querySelector<HTMLInputElement>('[aria-label="primary"]')?.value).toBe("#335566");
});

it("shows inline validation for an invalid hex color", async () => {
  await act(async () => root.render(<CustomThemeSelector />));
  await changeColor("background", "#zzzzzz");
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await Promise.resolve();
  });

  const input = container.querySelector<HTMLInputElement>('[aria-label="background"]');
  expect(input?.dataset.invalid).toBe("true");
  expect(container.textContent).toContain("enter_a_valid_hex_code_of_6_characters");
  expect(mocks.updateUserTheme).not.toHaveBeenCalled();
});

it("saves a valid custom theme in place with one success toast", async () => {
  await act(async () => root.render(<CustomThemeSelector />));
  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await Promise.resolve();
  });

  expect(mocks.updateUserTheme).toHaveBeenCalledWith({
    theme: "custom",
    primary: "#426b67",
    background: "#1a1a1a",
    darkPalette: true,
  });
  expect(mocks.setToast).toHaveBeenCalledTimes(1);
  expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  expect(mocks.reload).not.toHaveBeenCalled();
});
