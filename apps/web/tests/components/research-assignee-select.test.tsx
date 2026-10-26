// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TResearchAssignableUser } from "@plane/types";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      return typeof value === "string" ? value : key;
    },
  }),
}));

const { ResearchAssigneeSelect } = await import("@/components/research/chains/research-assignee-select");

const candidates: TResearchAssignableUser[] = [
  {
    user_id: "student-1",
    display_name: "李同学",
    org_unit_id: "unit-1",
    org_unit_name: "智能材料组",
    org_role: "REVIEWER",
    is_primary: true,
    scope: "ORG_SCOPE",
  },
  {
    user_id: "advisor-1",
    display_name: "王导师",
    org_unit_id: null,
    org_unit_name: null,
    org_role: null,
    is_primary: false,
    scope: "COLLABORATOR",
  },
];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let outsideTarget: HTMLButtonElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  outsideTarget = document.createElement("button");
  outsideTarget.type = "button";
  outsideTarget.textContent = "菜单外部区域";
  document.body.append(outsideTarget);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  outsideTarget.remove();
  vi.clearAllMocks();
});

/** 渲染受控负责人选择器，并返回提交回调。 */
async function renderSelect(initialValue = "") {
  const onChange = vi.fn();

  function Harness() {
    const [value, setValue] = useState(initialValue);
    return (
      <ResearchAssigneeSelect
        candidates={candidates}
        value={value}
        label="责任人"
        onChange={(userId) => {
          setValue(userId);
          onChange(userId);
        }}
      />
    );
  }

  await act(async () => root.render(<Harness />));
  return onChange;
}

/** 打开负责人浮层。 */
async function openMenu() {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="责任人"]');
  if (!trigger) throw new Error("负责人触发器未找到");
  await act(async () => trigger.click());
}

/** 触发外部点击，并等待现有外点检测的延迟关闭回调。 */
async function clickOutside() {
  await act(async () => {
    outsideTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

it("closes the assignee menu after an outside click without committing a value", async () => {
  const onChange = await renderSelect("student-1");
  await openMenu();

  await clickOutside();

  expect(container.querySelector('[role="listbox"]')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});

it("clears a non-empty search before Escape closes the assignee menu", async () => {
  await renderSelect();
  await openMenu();
  const input = container.querySelector<HTMLInputElement>('input[type="search"]');
  if (!input) throw new Error("负责人搜索输入框未找到");

  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, "王导师");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });

  expect(input.value).toBe("");
  expect(container.querySelector('[role="listbox"]')).not.toBeNull();

  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  expect(container.querySelector('[role="listbox"]')).toBeNull();
});

it("keeps option and clear commits closing the menu", async () => {
  const onChange = await renderSelect();
  await openMenu();
  const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
    item.textContent?.includes("王导师")
  );
  if (!option) throw new Error("王导师选项未找到");

  await act(async () => option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));

  expect(onChange).toHaveBeenCalledWith("advisor-1");
  expect(container.querySelector('[role="listbox"]')).toBeNull();

  await openMenu();
  const clear = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent === "未指派"
  );
  if (!clear) throw new Error("未指派选项未找到");
  await act(async () => clear.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));

  expect(onChange).toHaveBeenLastCalledWith("");
  expect(container.querySelector('[role="listbox"]')).toBeNull();
});
