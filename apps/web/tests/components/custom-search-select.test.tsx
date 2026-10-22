// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CustomSearchSelect } from "@plane/ui";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });

function Harness() {
  const [value, setValue] = useState("current");

  return (
    <>
      <CustomSearchSelect
        value={value}
        onChange={setValue}
        customButton={<span>Current project</span>}
        options={[
          { value: "current", query: "current project", content: "Current project" },
          { value: "next", query: "next project", content: "Next project" },
        ]}
      />
      <output>{value}</output>
    </>
  );
}

function MultipleHarness() {
  const [values, setValues] = useState<string[]>([]);

  return (
    <>
      <CustomSearchSelect
        multiple
        value={values}
        onChange={setValues}
        customButton={<span>Select members</span>}
        options={[
          { value: "alice", query: "alice chen alice.chen alice@example.com", content: "Alice Chen" },
          { value: "bob", query: "bob wang bob.wang bob@example.com", content: "Bob Wang" },
        ]}
      />
      <output>{values.join(",")}</output>
    </>
  );
}

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
  document.body.querySelectorAll("[role='listbox']").forEach((element) => element.remove());
});

it("commits a portal-rendered option", async () => {
  await act(async () => root.render(<Harness />));

  const trigger = container.querySelector<HTMLButtonElement>("button");
  await act(async () => trigger?.click());

  const option = [...document.body.querySelectorAll<HTMLElement>("[role='option']")].find(
    (element) => element.textContent === "Next project"
  );
  expect(option).toBeTruthy();

  await act(async () => option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));

  expect(container.querySelector("output")?.textContent).toBe("next");
});

it("commits an option through a complete pointer click", async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());

  const option = [...document.body.querySelectorAll<HTMLElement>("[role='option']")].find(
    (element) => element.textContent === "Next project"
  );
  expect(option).toBeTruthy();
  await act(async () => {
    option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    option?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    option?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });

  expect(container.querySelector("output")?.textContent).toBe("next");
});

it("allows native mouse focus on the search input inside the options panel", async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());

  const input = document.body.querySelector<HTMLInputElement>('input[role="combobox"]');
  expect(input).not.toBeNull();
  const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  await act(async () => input?.dispatchEvent(mouseDown));

  // Preventing mousedown cancels the browser's default input focus action.
  expect(mouseDown.defaultPrevented).toBe(false);
});

it("支持多选连续提交且搜索可匹配账号和邮箱", async () => {
  await act(async () => root.render(<MultipleHarness />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());

  const searchInput = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    valueSetter?.call(searchInput, "bob@example.com");
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  });

  expect([...document.body.querySelectorAll("[role='option']")].map((element) => element.textContent)).toEqual([
    "Bob Wang",
  ]);

  await act(async () => {
    valueSetter?.call(searchInput, "");
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));
  });

  const options = [...document.body.querySelectorAll<HTMLElement>("[role='option']")];
  const selectOption = async (option: HTMLElement) => {
    await act(async () => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
      option.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
  };

  await selectOption(options[0]);
  await selectOption(options[1]);

  expect(container.querySelector("output")?.textContent).toBe("alice,bob");
  expect(document.querySelector("[role='listbox']")).not.toBeNull();
});

it("开闭通知仅在状态变化后各触发一次，Esc 和外部点击仍然有效", async () => {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const navigate = vi.fn();
  const errors = vi.spyOn(console, "error");
  /** 复现面包屑中开闭回调更新父组件的场景。 */
  function CallbackHarness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <CustomSearchSelect
          value="current"
          onChange={() => undefined}
          label="当前项目"
          options={[{ value: "current", query: "current", content: "当前项目" }]}
          onOpen={() => {
            onOpen();
            setOpen(true);
          }}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
        <output>{String(open)}</output>
        <button onClick={navigate}>管理</button>
      </>
    );
  }
  try {
    await act(async () => root.render(<CallbackHarness />));
    const trigger = container.querySelector<HTMLButtonElement>("button")!;
    await act(async () => trigger.click());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(container.querySelector("output")?.textContent).toBe("true");
    await act(async () =>
      document
        .querySelector("input")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    );
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(onClose).toHaveBeenCalledOnce();
    await act(async () => trigger.click());
    const target = [...container.querySelectorAll("button")].find((button) => button.textContent === "管理")!;
    await act(async () => {
      target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      target.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(navigate).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(errors.mock.calls.flat().join(" ")).not.toContain("Cannot update a component");
  } finally {
    errors.mockRestore();
  }
});
