"use client";

import { useEffect, useMemo, useState } from "react";
import { endOfISOWeek, endOfMonth, getISOWeek, getISOWeekYear, startOfISOWeek } from "date-fns";
import { CalendarOutline } from "@makeplane/propel/icons";
import { DEFAULT_TIMEZONE } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Calendar } from "@plane/propel/calendar";
import { Popover } from "@plane/propel/popover";
import type { TReportType } from "@plane/types";

export type TCustomReportPeriod = {
  reportType: TReportType;
  periodKey: string;
};

type Props = {
  customPeriod: TCustomReportPeriod | null;
  reportTimezone?: string;
  onSelect: (period: TCustomReportPeriod) => void;
};

type CalendarProps = {
  value: TCustomReportPeriod | null;
  reportTimezone?: string;
  onSelect: (period: TCustomReportPeriod) => void;
  onTypeChange?: (period: TCustomReportPeriod) => void;
};

/** 读取工作区报告时区中的当前日历日期。 */
export function reportTodayInTimezone(reportTimezone?: string, now = new Date()): Date {
  const timezone = reportTimezone || DEFAULT_TIMEZONE;

  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return new Date(Number(values.year), Number(values.month) - 1, Number(values.day));
  } catch {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
}

/** 计算当前 ISO 周或自然月可选择的最后日期。 */
export function reportPeriodEnd(reportType: TReportType, reportTimezone?: string, now = new Date()): Date {
  const today = reportTodayInTimezone(reportTimezone, now);
  return reportType === "WEEKLY" ? endOfISOWeek(today) : endOfMonth(today);
}

/** 将日历日期转换为后端使用的报告周期键。 */
export function reportPeriodKey(reportType: TReportType, date: Date): string {
  if (reportType === "MONTHLY") {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  return `${getISOWeekYear(date)}-W${String(getISOWeek(date)).padStart(2, "0")}`;
}

/** 将自定义周期键转换为日历控件的初始日期。 */
function selectedDate(period: TCustomReportPeriod | null): Date | undefined {
  if (!period) return undefined;

  if (period.reportType === "MONTHLY") {
    const match = /^(\d{4})-(\d{2})$/.exec(period.periodKey);
    if (!match) return undefined;
    return new Date(Number(match[1]), Number(match[2]) - 1, 1);
  }

  const match = /^(\d{4})-W(\d{2})$/.exec(period.periodKey);
  if (!match) return undefined;
  const isoYear = Number(match[1]);
  const isoWeek = Number(match[2]);
  return startOfISOWeek(new Date(isoYear, 0, 4 + (isoWeek - 1) * 7));
}

/** 解析报告周期覆盖的日历区间。 */
export function reportPeriodDates(period: TCustomReportPeriod): { start: Date; end: Date } | null {
  if (period.reportType === "MONTHLY") {
    const match = /^(\d{4})-(\d{2})$/.exec(period.periodKey);
    if (!match) return null;
    const start = new Date(Number(match[1]), Number(match[2]) - 1, 1);
    return { start, end: endOfMonth(start) };
  }

  const match = /^(\d{4})-W(\d{2})$/.exec(period.periodKey);
  if (!match) return null;
  const start = startOfISOWeek(new Date(Number(match[1]), 0, 4 + (Number(match[2]) - 1) * 7));
  return { start, end: endOfISOWeek(start) };
}

/** 以报告周期使用的本地日期格式展示起止日期。 */
export function formatReportPeriodDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** 提供报告创建与首页摘要共用的周 / 月内联日历。 */
export function ReportPeriodCalendar({ value, reportTimezone, onSelect, onTypeChange }: CalendarProps) {
  const { t } = useTranslation();
  const today = useMemo(() => reportTodayInTimezone(reportTimezone), [reportTimezone]);
  const [typeOverride, setTypeOverride] = useState<TReportType | null>(null);
  const [activeDate, setActiveDate] = useState<Date | undefined>(() => {
    if (!value) return undefined;
    const initialDate = selectedDate(value);
    if (!initialDate) return undefined;
    return reportPeriodKey(value.reportType, initialDate) === reportPeriodKey(value.reportType, today)
      ? today
      : initialDate;
  });
  const reportType: TReportType = typeOverride ?? value?.reportType ?? "WEEKLY";
  const selectableEnd = reportPeriodEnd(reportType, reportTimezone);

  useEffect(() => {
    setTypeOverride(null);
  }, [value]);

  useEffect(() => {
    if (!value) return;
    if (reportPeriodKey(value.reportType, activeDate ?? today) === value.periodKey) return;
    const nextDate = selectedDate(value);
    const isCurrentPeriod = reportPeriodKey(value.reportType, today) === value.periodKey;
    const isNextDateValid = nextDate !== undefined && reportPeriodKey(value.reportType, nextDate) === value.periodKey;
    if (isCurrentPeriod || !isNextDateValid) setActiveDate(today);
    else setActiveDate(nextDate);
  }, [activeDate, today, value]);

  /** 切换周 / 月时保持同一日期上下文，避免跨周期默认值跳变。 */
  const selectType = (nextType: TReportType) => {
    if (nextType === reportType) return;
    setTypeOverride(nextType);
    const date = activeDate ?? today;
    setActiveDate(date);
    onTypeChange?.({ reportType: nextType, periodKey: reportPeriodKey(nextType, date) });
  };

  /** 仅接受当前与历史周期，未来日期保持原选择。 */
  const selectDate = (date: Date | undefined) => {
    if (!date || date > selectableEnd) return;
    setActiveDate(date);
    onSelect({ reportType, periodKey: reportPeriodKey(reportType, date) });
  };

  return (
    <div className="flex flex-col gap-3">
      <div
        className="flex w-fit overflow-hidden rounded-md border border-subtle"
        role="group"
        aria-label={t("research.home_workbench.select_report_period")}
      >
        {(
          [
            { value: "WEEKLY", label: t("research.home_workbench.by_week") },
            { value: "MONTHLY", label: t("research.home_workbench.by_month") },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={reportType === option.value}
            className={`px-2.5 py-1.5 text-12 transition-colors ${
              reportType === option.value ? "bg-surface-2 text-primary" : "text-secondary hover:bg-surface-1"
            }`}
            onClick={() => selectType(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <Calendar
        mode="single"
        selected={activeDate}
        defaultMonth={activeDate ?? selectableEnd}
        onSelect={selectDate}
        disabled={{ after: selectableEnd }}
        captionLayout="dropdown"
        fixedWeeks
        showOutsideDays
        initialFocus
        ISOWeek={reportType === "WEEKLY"}
        showWeekNumber={reportType === "WEEKLY"}
      />
    </div>
  );
}

/** 为首页报告摘要提供历史与当前周期的紧凑日历入口。 */
export function ReportPeriodSelector({ customPeriod, reportTimezone, onSelect }: Props) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  /** 日期选择后更新摘要并关闭弹层；周 / 月切换只改变日历模式。 */
  const handleSelect = (period: TCustomReportPeriod) => {
    onSelect(period);
    setIsOpen(false);
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <Popover.Button
        type="button"
        aria-label={t("research.home_workbench.select_report_period")}
        title={t("research.home_workbench.select_report_period")}
        className={`inline-flex h-7 items-center gap-1 rounded-md border border-subtle px-2 text-12 transition-colors hover:bg-surface-1 focus-visible:outline-none ${
          customPeriod ? "text-primary" : "px-1.5 text-secondary"
        }`}
      >
        <CalendarOutline aria-hidden="true" className="size-3.5 shrink-0" />
        {customPeriod && <span className="tabular-nums">{customPeriod.periodKey}</span>}
      </Popover.Button>
      {isOpen && (
        <Popover.Panel
          align="start"
          positionerClassName="z-50"
          className="z-50 w-[min(calc(100vw-2rem),19rem)] rounded-md border border-subtle bg-surface-1 p-3 shadow-raised-200"
        >
          <ReportPeriodCalendar value={customPeriod} reportTimezone={reportTimezone} onSelect={handleSelect} />
        </Popover.Panel>
      )}
    </Popover>
  );
}
