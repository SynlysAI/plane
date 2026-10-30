// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeStore } from "@/store/theme.store";
import { getContentBackgroundOpacity } from "@/helpers/workspace-backgrounds";

const state = {
  theme: new ThemeStore(),
  profile: {
    theme: {
      theme: "light",
      darkPalette: false,
      backgroundImage: "/background.jpg",
      contentBackgroundOpacity: undefined as number | undefined,
    },
  },
  resolvedTheme: "light",
};
vi.mock("@/hooks/store/use-app-theme", () => ({ useAppTheme: () => state.theme }));
vi.mock("@/hooks/store/user", () => ({ useUserProfile: () => ({ data: state.profile }) }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: state.resolvedTheme }) }));
const { WorkspaceBackgroundShell } = await import("@/components/workspace/background-shell");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  state.theme = new ThemeStore();
  state.profile.theme.backgroundImage = "/background.jpg";
  state.profile.theme.contentBackgroundOpacity = undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("历史偏好使用 0.85，实时预览可覆盖为 0，清除后恢复已保存值", async () => {
  await act(async () =>
    root.render(
      <WorkspaceBackgroundShell>
        <span>内容</span>
      </WorkspaceBackgroundShell>
    )
  );
  const shell = container.firstElementChild as HTMLElement;
  expect(shell.style.getPropertyValue("--workspace-content-opacity")).toBe("0.85");
  await act(async () => state.theme.setContentBackgroundOpacityPreview(0));
  expect(shell.style.getPropertyValue("--workspace-content-opacity")).toBe("0");
  await act(async () => state.theme.setContentBackgroundOpacityPreview(undefined));
  expect(shell.style.getPropertyValue("--workspace-content-opacity")).toBe("0.85");
  expect(shell.style.opacity).toBe("");
  expect(shell.querySelector("span")?.style.opacity).toBe("");
});

it("没有背景图片时恢复普通画布，不应用透明度变量", async () => {
  state.profile.theme.backgroundImage = "";
  await act(async () => root.render(<WorkspaceBackgroundShell>内容</WorkspaceBackgroundShell>));
  expect(container.firstElementChild?.classList.contains("bg-canvas")).toBe(true);
  expect(container.querySelector(".workspace-background-layer")).toBeNull();
  expect((container.firstElementChild as HTMLElement).style.getPropertyValue("--workspace-content-opacity")).toBe("");
});

it.each([undefined, null, NaN, Infinity, "0.5"])("非法偏好 %s 回退到默认值", (value) => {
  expect(getContentBackgroundOpacity(value)).toBe(0.85);
});

it("有效值保留边界并限制到 0-1", () => {
  expect(getContentBackgroundOpacity(0)).toBe(0);
  expect(getContentBackgroundOpacity(1)).toBe(1);
  expect(getContentBackgroundOpacity(-1)).toBe(0);
  expect(getContentBackgroundOpacity(2)).toBe(1);
});
