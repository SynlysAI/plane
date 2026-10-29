// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
vi.mock("@/hooks/store/user", () => ({
  useUserProfile: () => ({ data: { start_of_the_week: 0 } }),
}));
vi.mock("@plane/propel/calendar", () => ({
  Calendar: () => (
    <select aria-label="Choose the Month">
      <option value="9">October</option>
      <option value="10">November</option>
    </select>
  ),
}));

const { DateDropdown } = await import("@/components/dropdowns/date");
const { DateRangeDropdown } = await import("@/components/dropdowns/date-range");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** 渲染日期控件测试挂载点。 */
function renderFixture(element: React.ReactElement) {
  return act(async () => root.render(element));
}

/** 查找包含指定文本的按钮。 */
function buttonByText(text: string) {
  const target = [...document.querySelectorAll("button")].find((item) => item.textContent?.includes(text));
  if (!target) throw new Error(`未找到按钮：${text}`);
  return target;
}

/** 断生日历弹层中的原生月份下拉不会被外层容器取消默认行为。 */
function expectNativeSelectToKeepDefaultBehavior() {
  const panel = document.querySelector<HTMLElement>("[data-prevent-outside-click]");
  expect(panel).not.toBeNull();
  const monthSelect = panel?.querySelector<HTMLSelectElement>('select[aria-label="Choose the Month"]');
  expect(monthSelect).not.toBeNull();

  const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  monthSelect?.dispatchEvent(mousedown);
  expect(mousedown.defaultPrevented).toBe(false);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.querySelectorAll("[data-prevent-outside-click]").forEach((node) => node.remove());
  vi.unstubAllGlobals();
});

describe("date dropdown native caption selects", () => {
  it("allows the single-date month select to open", async () => {
    await renderFixture(
      <DateDropdown value={null} onChange={vi.fn()} placeholder="选择日期" buttonVariant="border-with-text" />
    );
    await act(async () => buttonByText("选择日期").click());
    expectNativeSelectToKeepDefaultBehavior();
  });

  it("allows the date-range month select to open", async () => {
    await renderFixture(
      <DateRangeDropdown
        value={{ from: undefined, to: undefined }}
        onSelect={vi.fn()}
        placeholder={{ from: "开始日期", to: "结束日期" }}
        buttonVariant="border-with-text"
      />
    );
    await act(async () => buttonByText("开始日期").click());
    expectNativeSelectToKeepDefaultBehavior();
  });
});
