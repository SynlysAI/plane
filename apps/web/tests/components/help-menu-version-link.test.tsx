// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@plane/ui", () => ({
  CustomMenu: Object.assign(
    ({ children, customButton }: { children: React.ReactNode; customButton: React.ReactNode }) => (
      <div>
        {customButton}
        <div>{children}</div>
      </div>
    ),
    {
      MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
        <button type="button" onClick={onClick}>
          {children}
        </button>
      ),
    }
  ),
}));

vi.mock("@/components/sidebar/sidebar-item", () => ({
  AppSidebarItem: {
    Icon: ({ icon }: { icon: React.ReactNode }) => <button type="button">{icon}</button>,
  },
}));

vi.mock("@/components/global/version-number", () => ({
  PlaneVersionNumber: () => <span>v7.0.0</span>,
}));

vi.mock("@/hooks/store/use-power-k", () => ({
  usePowerK: () => ({ toggleShortcutsListModal: vi.fn() }),
}));

const { HelpMenuRoot } = await import("@/components/workspace/sidebar/help-section/root");
const { VERSION_NOTES_URL } = await import("@plane/constants");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.spyOn(window, "open").mockImplementation(() => null);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

it("复用 What's new 入口并使用新标签页打开版本说明", async () => {
  await act(async () => root.render(<HelpMenuRoot />));

  const versionItems = Array.from(container.querySelectorAll("button")).filter(
    (button) => button.textContent === "whats_new"
  );
  expect(versionItems).toHaveLength(1);

  await act(async () => versionItems[0]?.click());
  expect(window.open).toHaveBeenCalledWith(VERSION_NOTES_URL, "_blank", "noopener,noreferrer");
  expect(VERSION_NOTES_URL).toBe("https://gcnpf55d0gns.feishu.cn/wiki/KSOBw5jtEiFDMckX9cMcPgScnEc");
});
