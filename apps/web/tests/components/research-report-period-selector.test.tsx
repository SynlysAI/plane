// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "research.home_workbench.select_report_period": "选择报告周期",
        "research.home_workbench.by_week": "按周",
        "research.home_workbench.by_month": "按月",
      })[key] ?? key,
  }),
}));

vi.mock("@plane/propel/calendar", () => ({
  Calendar: ({ onSelect, disabled }: { onSelect: (date: Date | undefined) => void; disabled?: { after?: Date } }) => (
    <div data-testid="period-calendar">
      <button type="button" onClick={() => onSelect(new Date(2026, 8, 15))}>
        选择 2026-09-15
      </button>
      <button type="button" onClick={() => onSelect(new Date(2027, 0, 1))}>
        选择未来日期
      </button>
      <span data-testid="disabled-after">{disabled?.after?.toISOString()}</span>
    </div>
  ),
}));

const { ReportPeriodCalendar, reportPeriodKey } = await import("@/components/research/reports/report-period-selector");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const selected: Array<{ reportType: string; periodKey: string }> = [];

function renderCalendar() {
  return act(async () =>
    root.render(
      <ReportPeriodCalendar
        value={{ reportType: "WEEKLY", periodKey: "2026-W44" }}
        reportTimezone="Asia/Shanghai"
        onSelect={(period) => selected.push(period)}
        onTypeChange={(period) => selected.push(period)}
      />
    )
  );
}

function button(label: string) {
  const target = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!target) throw new Error(`未找到按钮：${label}`);
  return target;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 27, 15, 0, 0));
  selected.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

it("生成周报与月报的规范周期键", () => {
  expect(reportPeriodKey("WEEKLY", new Date(2026, 8, 15))).toBe("2026-W38");
  expect(reportPeriodKey("MONTHLY", new Date(2026, 8, 15))).toBe("2026-09");
});

it("切换周月时基于同一日期重算周期", async () => {
  await renderCalendar();
  await act(async () => button("按月").click());
  expect(selected).toEqual([{ reportType: "MONTHLY", periodKey: "2026-10" }]);
});

it("选择历史日期输出历史周期", async () => {
  await renderCalendar();
  await act(async () => button("选择 2026-09-15").click());
  expect(selected).toEqual([{ reportType: "WEEKLY", periodKey: "2026-W38" }]);
});

it("不输出未来周期", async () => {
  await renderCalendar();
  await act(async () => button("选择未来日期").click());
  expect(selected).toEqual([]);
});
