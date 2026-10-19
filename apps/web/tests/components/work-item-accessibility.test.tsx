// @vitest-environment jsdom
import React, { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContextMenu, CustomMenu } from "@plane/ui";
import type { TContextMenuItem } from "@plane/ui";
import { CreateMoreSwitch } from "@/components/issues/create-more-switch";
import { ResizableSidebar } from "@/components/sidebar/resizable-sidebar";

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: () => "创建更多" }) }));
vi.mock("@plane/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@plane/hooks")>()),
  usePlatformOS: () => ({ isMobile: false }),
}));

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(window, { PointerEvent: MouseEvent });
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
  vi.restoreAllMocks();
});

/** 挂载真实开关并记录每次用户操作。 */
function SwitchHarness({ onChange }: { onChange: (checked: boolean) => void }) {
  const [checked, setChecked] = useState(false);
  return (
    <CreateMoreSwitch
      checked={checked}
      onCheckedChange={(value) => {
        setChecked(value);
        onChange(value);
      }}
    />
  );
}

it("创建更多只有一个控件和名称，标签与开关点击均只切换一次", async () => {
  const onChange = vi.fn();
  await act(async () => root.render(<SwitchHarness onChange={onChange} />));
  const control = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(container.querySelectorAll('[role="switch"], [role="button"]')).toHaveLength(1);
  expect(control.labels?.[0].textContent).toBe("创建更多");
  expect(control.getAttribute("aria-label")).toBeNull();
  await act(async () => container.querySelector<HTMLSpanElement>("label span")!.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  expect(control.getAttribute("aria-checked")).toBe("true");
  await act(async () => control.click());
  expect(onChange.mock.calls).toEqual([[true], [false]]);
});

/** 为每行挂载独立右键菜单，复现列表中的菜单数量。 */
function ContextRow({ name, items }: { name: string; items: TContextMenuItem[] }) {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rowRef} data-row={name}>
      {name}
      <ContextMenu parentRef={rowRef} items={items} ariaLabel={`${name} 的操作`} />
    </div>
  );
}

/** 通过原生右键事件打开指定行菜单。 */
async function openMenu(name: string) {
  await act(async () =>
    container
      .querySelector(`[data-row="${name}"]`)!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }))
  );
}

it("关闭的行菜单不挂载，右键和 Esc 可反复开闭", async () => {
  const action = vi.fn();
  const items = [{ key: "edit", title: "编辑", action }];
  await act(async () =>
    root.render(
      <>
        <ContextRow name="一" items={items} />
        <ContextRow name="二" items={items} />
      </>
    )
  );
  expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  await openMenu("一");
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
  expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("一 的操作");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  await openMenu("二");
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  expect(action).toHaveBeenCalledOnce();
  expect(document.querySelectorAll('[role="menu"]')).toHaveLength(0);
});

it("外部点击关闭菜单且同一次点击仍执行目标操作", async () => {
  const navigate = vi.fn();
  await act(async () =>
    root.render(
      <>
        <ContextRow name="一" items={[{ key: "edit", title: "编辑", action: vi.fn() }]} />
        <button onClick={navigate}>管理</button>
      </>
    )
  );
  await openMenu("一");
  const target = [...container.querySelectorAll("button")].find((button) => button.textContent === "管理")!;
  await act(async () => {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    target.click();
  });
  expect(navigate).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("嵌套菜单用 Enter 执行时只调用子菜单动作", async () => {
  const parentAction = vi.fn();
  const nestedAction = vi.fn();
  await act(async () =>
    root.render(
      <ContextRow
        name="一"
        items={[
          {
            key: "move",
            title: "移动",
            action: parentAction,
            nestedMenuItems: [{ key: "destination", title: "目标项目", action: nestedAction }],
          },
        ]}
      />
    )
  );
  await openMenu("一");
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  const nested = document.querySelector('[data-context-submenu="true"] [role="menu"]')!;
  expect(nested).not.toBeNull();
  await act(async () =>
    nested.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))
  );
  expect(nestedAction).toHaveBeenCalledOnce();
  expect(parentAction).not.toHaveBeenCalled();
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("所有操作不可见时不打开空菜单", async () => {
  await act(async () =>
    root.render(
      <ContextRow
        name="一"
        items={[
          {
            key: "hidden",
            title: "隐藏",
            action: vi.fn(),
            shouldRender: false,
          },
        ]}
      />
    )
  );
  await openMenu("一");
  expect(document.querySelector('[role="menu"]')).toBeNull();
});

it("行省略菜单用 Esc 关闭后卸载内容并恢复焦点", async () => {
  const close = vi.fn();
  await act(async () =>
    root.render(
      <CustomMenu ellipsis ariaLabel="工作项一的操作" onMenuClose={close}>
        <CustomMenu.MenuItem onClick={vi.fn()}>编辑</CustomMenu.MenuItem>
      </CustomMenu>
    )
  );
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="工作项一的操作"]')!;
  await act(async () => trigger.click());
  const menu = document.querySelector('[role="menu"]')!;
  expect(menu).not.toBeNull();
  await act(async () =>
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(close).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(trigger);
});

it("侧栏展开、折叠与预览仅保留一份可访问内容", async () => {
  /** 按外部状态挂载真实侧栏。 */
  const renderSidebar = async (isCollapsed: boolean, showPeek = false) => {
    await act(async () =>
      root.render(
        <ResizableSidebar
          width={260}
          setWidth={vi.fn()}
          togglePeek={vi.fn()}
          toggleCollapsed={vi.fn()}
          isCollapsed={isCollapsed}
          showPeek={showPeek}
        >
          <nav aria-label="项目导航">
            <a href="/project">报告材料</a>
          </nav>
        </ResizableSidebar>
      )
    );
  };
  await renderSidebar(false);
  expect(container.querySelectorAll("nav")).toHaveLength(1);
  expect(container.querySelectorAll('[role="complementary"][aria-hidden="false"]')).toHaveLength(1);
  await renderSidebar(true);
  expect(container.querySelectorAll("nav")).toHaveLength(0);
  expect(container.querySelectorAll("[inert]")).toHaveLength(2);
  await renderSidebar(true, true);
  expect(container.querySelectorAll("nav")).toHaveLength(1);
  expect(container.querySelector('[aria-label="Sidebar peek view"]')?.getAttribute("aria-hidden")).toBe("false");
  await renderSidebar(false);
  expect(container.querySelectorAll("nav")).toHaveLength(1);
});
