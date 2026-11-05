// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, Link, RouterProvider } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TEmailRecipientFilterPolicy } from "@plane/types";

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), check: vi.fn() }));
vi.mock("@makeplane/propel/elements/input", () => ({
  InputGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@plane/services", () => ({
  InstanceService: class {
    emailRecipientFilters = mocks.load;
    updateEmailRecipientFilters = mocks.save;
    checkEmailRecipientFilters = mocks.check;
  },
}));
vi.mock("@makeplane/propel/components/button", () => ({
  Button: ({
    label,
    loading,
    disabled,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; loading?: boolean }) => (
    <button {...props} disabled={disabled || loading}>
      {label}
    </button>
  ),
}));
vi.mock("@makeplane/propel/components/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));
vi.mock("@makeplane/propel/components/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <button {...props} type="button" role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)} />
  ),
}));
vi.mock("@makeplane/propel/components/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

import EmailFiltersPage from "../../app/(all)/(dashboard)/email-filters/page";

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  React,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
});
const original: TEmailRecipientFilterPolicy = {
  enabled: true,
  rules: [
    {
      id: "c1275450-bc1f-40b7-b18e-c71436cb0a2c",
      type: "email",
      value: "admin@ai4ms.local",
      note: "管理员专用虚拟邮箱",
      enabled: true,
    },
    {
      id: "fddb22f5-4996-4343-85ce-6d246c75d655",
      type: "domain",
      value: "example.com",
      note: "测试域名",
      enabled: false,
    },
  ],
};
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

beforeEach(() => {
  mocks.load.mockResolvedValue(structuredClone(original));
  mocks.save.mockImplementation(async (policy) => policy);
  mocks.check.mockResolvedValue({ email: "admin@ai4ms.local", blocked: true, matched_rule: original.rules[0] });
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

/** 在真实数据路由中渲染页面，覆盖导航阻断的生命周期。 */
async function render() {
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <>
          <EmailFiltersPage />
          <Link to="/other">其他页面</Link>
        </>
      ),
    },
    { path: "/other", element: <p>已离开</p> },
  ]);
  root = createRoot(container);
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}

/** 按可见名称或无障碍名称定位按钮，包括传送到弹窗的内容。 */
function button(name: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent === name || item.getAttribute("aria-label") === name
  );
  if (!found) throw new Error(`未找到按钮：${name}`);
  return found;
}

/** 使用原生输入事件触发 React 受控字段。 */
async function fill(id: string, value: string) {
  const element = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

/** 模拟表单提交，避免 jsdom 未实现的原生 requestSubmit。 */
async function submit(label: string) {
  await act(async () =>
    button(label)
      .closest("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
}

it("加载与失败重试不依赖 SMTP 开关", async () => {
  mocks.load.mockRejectedValueOnce({ error: "email_recipient_filters_unavailable" });
  await render();
  expect(document.body.textContent).toContain("无法读取邮箱过滤配置");
  await act(async () => button("重新加载").click());
  expect(document.body.textContent).toContain("admin@ai4ms.local");
  expect(mocks.load).toHaveBeenCalledTimes(2);
});

it("读取期间显示加载状态", async () => {
  let resolve!: (policy: TEmailRecipientFilterPolicy) => void;
  mocks.load.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    })
  );
  await render();
  expect(document.body.textContent).toContain("正在加载邮箱过滤规则");
  await act(async () => resolve(original));
  expect(document.body.textContent).toContain("所有更改已保存");
});

it("总开关和单条规则为草稿，取消恢复已保存状态", async () => {
  await render();
  await act(async () => button("启用邮箱过滤").click());
  await act(async () => button("停用 admin@ai4ms.local").click());
  expect(document.body.textContent).toContain("有未保存更改");
  expect(mocks.save).not.toHaveBeenCalled();
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  await act(async () => button("取消").click());
  expect(button("启用邮箱过滤").getAttribute("aria-checked")).toBe("true");
  expect(document.body.textContent).toContain("所有更改已保存");
});

it("保存失败保留草稿，重试成功后更新基线", async () => {
  await render();
  await act(async () => button("停用 admin@ai4ms.local").click());
  mocks.save.mockRejectedValueOnce({ error: "offline" });
  await act(async () => button("保存更改").click());
  expect(document.body.textContent).toContain("保存失败，草稿已保留");
  expect(button("启用 admin@ai4ms.local")).toBeTruthy();
  await act(async () => button("重试保存").click());
  expect(mocks.save.mock.calls[1]![0].rules[0].enabled).toBe(false);
  expect(document.body.textContent).toContain("下一次发送检查将使用新规则");
  expect(button("保存更改").disabled).toBe(true);
});

it("搜索、类型和状态筛选可组合，空结果可清除", async () => {
  await render();
  await fill("email-filter-type", "domain");
  expect(document.querySelector("table")!.textContent).not.toContain("admin@ai4ms.local");
  await fill("email-filter-status", "enabled");
  expect(document.body.textContent).toContain("没有符合筛选条件的规则");
  await act(async () => button("清除筛选").click());
  await fill("email-filter-search", "管理员");
  expect(document.querySelector("table")!.textContent).toContain("admin@ai4ms.local");
  expect(document.querySelector("table")!.textContent).not.toContain("example.com");
});

it("编辑保留稳定 ID，并将更新加入草稿", async () => {
  await render();
  await act(async () => button("编辑 admin@ai4ms.local").click());
  await fill("filter-rule-value", "new@ai4ms.local");
  await fill("filter-rule-note", "新备注");
  await submit("更新草稿");
  expect(document.querySelector("table")!.textContent).toContain("new@ai4ms.local");
  expect(mocks.check.mock.calls[0]![1].rules[0].id).toBe(original.rules[0]!.id);
  expect(mocks.save).not.toHaveBeenCalled();
});

it("批量添加逐项提示非法与重复项，可只加入有效项", async () => {
  await render();
  await act(async () => button("添加规则").click());
  await act(async () => (document.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  await fill("filter-rule-value", "valid@example.org\ninvalid\nadmin@ai4ms.local");
  mocks.check.mockRejectedValueOnce({
    detail: {
      rules: [
        { index: 3, message: "请输入有效的邮箱地址。" },
        { index: 4, message: "与已有规则重复。" },
      ],
    },
  });
  await submit("加入草稿");
  expect(document.body.textContent).toContain("第 2 项 · invalid");
  expect(document.body.textContent).toContain("第 3 项 · admin@ai4ms.local");
  expect(document.querySelector("table")!.textContent).not.toContain("valid@example.org");
  await act(async () => button("仅添加 1 条有效规则").click());
  expect(document.querySelector("table")!.textContent).toContain("valid@example.org");
  expect(mocks.check.mock.calls[1]![1].rules).toHaveLength(3);
});

it("删除最后一条规则允许保存空列表", async () => {
  mocks.load.mockResolvedValue({ ...original, rules: [original.rules[0]] });
  await render();
  await act(async () => button("删除 admin@ai4ms.local").click());
  await act(async () => button("删除规则").click());
  expect(document.body.textContent).toContain("尚无屏蔽规则");
  await act(async () => button("保存更改").click());
  expect(mocks.save).toHaveBeenCalledWith({ enabled: true, rules: [] });
});

it("规则检查提交当前草稿，后续编辑清除旧结论", async () => {
  await render();
  await act(async () => button("停用 admin@ai4ms.local").click());
  await fill("email-filter-check", "admin@ai4ms.local");
  await submit("检查规则");
  expect(mocks.check).toHaveBeenCalledWith(
    "admin@ai4ms.local",
    expect.objectContaining({ rules: [expect.objectContaining({ enabled: false }), original.rules[1]] })
  );
  expect(document.body.textContent).toContain("将被屏蔽 · 命中邮箱规则");
  await fill("email-filter-check", "other@example.com");
  expect(document.body.textContent).not.toContain("将被屏蔽 · 命中邮箱规则");
});

it("草稿检查失败显示错误，并可修正重试", async () => {
  await render();
  await fill("email-filter-check", "invalid");
  mocks.check.mockRejectedValueOnce({ detail: "请输入有效的邮箱地址。" });
  await submit("检查规则");
  expect(document.body.textContent).toContain("请输入有效的邮箱地址。");
  await fill("email-filter-check", "other@example.com");
  mocks.check.mockResolvedValueOnce({ email: "other@example.com", blocked: false, matched_rule: null });
  await submit("检查规则");
  expect(document.body.textContent).toContain("允许发送 · 未命中启用的规则");
});

it("未保存导航可继续编辑或明确放弃", async () => {
  const router = await render();
  await act(async () => button("启用邮箱过滤").click());
  await act(async () => (document.querySelector('a[href="/other"]') as HTMLAnchorElement).click());
  expect(document.body.textContent).toContain("有未保存的更改");
  await act(async () => button("继续编辑").click());
  expect(router.state.location.pathname).toBe("/");
  await act(async () => (document.querySelector('a[href="/other"]') as HTMLAnchorElement).click());
  await act(async () => button("放弃并离开").click());
  expect(document.body.textContent).toContain("已离开");
});

it("关闭规则弹窗保护尚未加入草稿的输入", async () => {
  await render();
  await act(async () => button("添加规则").click());
  await fill("filter-rule-value", "new@example.com");
  const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
  await act(async () => button("关闭规则弹窗").click());
  expect(document.getElementById("filter-rule-value")).not.toBeNull();
  await act(async () => button("关闭规则弹窗").click());
  expect(confirm).toHaveBeenCalledTimes(2);
  expect(document.getElementById("filter-rule-value")).toBeNull();
});
