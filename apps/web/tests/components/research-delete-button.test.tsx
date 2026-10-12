// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      return typeof value === "string"
        ? value.replace(/\{(\w+)\}/g, (_match, name: string) => params?.[name] ?? "")
        : key;
    },
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, disabled, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("@plane/ui", () => ({
  ModalCore: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}));
const { ResearchDeleteButton } = await import("@/components/research/common/research-delete-button");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function click(label: string) {
  await act(async () => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === label || item.getAttribute("aria-label") === label
    );
    if (!button) throw new Error(`Missing button: ${label}`);
    button.click();
  });
}

it("requires confirmation and cancellation never calls delete", async () => {
  const remove = vi.fn();
  await act(async () => root.render(<ResearchDeleteButton name="误建周报" onDelete={remove} />));
  await click("删除 误建周报");
  expect(container.querySelector('[role="dialog"]')?.textContent).toContain("误建周报");
  expect(remove).not.toHaveBeenCalled();
  await click("取消");
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(remove).not.toHaveBeenCalled();
});

it("preserves the dialog and reports dependencies on failure, then allows retry", async () => {
  const remove = vi.fn().mockRejectedValueOnce({ error_code: "research_delete_blocked" }).mockResolvedValue(undefined);
  await act(async () => root.render(<ResearchDeleteButton name="项目" onDelete={remove} />));
  await click("删除 项目");
  await click("删除");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("关联数据");
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  await click("删除");
  expect(remove).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});

it("disables confirmation and cancellation while the request is pending", async () => {
  let finish!: () => void;
  const remove = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  await act(async () => root.render(<ResearchDeleteButton name="节点" onDelete={remove} />));
  await click("删除 节点");
  await click("删除");
  expect(
    Array.from(container.querySelectorAll('[role="dialog"] button')).every(
      (button) => (button as HTMLButtonElement).disabled
    )
  ).toBe(true);
  await act(async () => finish());
  expect(container.querySelector('[role="dialog"]')).toBeNull();
});
