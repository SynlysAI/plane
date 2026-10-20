"use client";

import { useState } from "react";
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

/** 将自定义周期键转换为日历控件的选中日期。 */
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

/** 为首页报告摘要提供历史与当前周期的紧凑日历入口。 */
export function ReportPeriodSelector({ customPeriod, reportTimezone, onSelect }: Props) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [reportType, setReportType] = useState<TReportType>(customPeriod?.reportType ?? "WEEKLY");
  const selectableEnd = reportPeriodEnd(reportType, reportTimezone);
  const pickerDate = customPeriod?.reportType === reportType ? selectedDate(customPeriod) : undefined;

  /** 仅在选择日期属于当前允许周期时更新报告摘要。 */
  const handleSelect = (date: Date | undefined) => {
    if (!date || date > selectableEnd) return;
    onSelect({ reportType, periodKey: reportPeriodKey(reportType, date) });
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
          className="z-50 w-[min(calc(100vw-2rem),19rem)] rounded-md border border-subtle bg-surface-1 p-3 shadow-raised-200"
        >
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
                onClick={() => setReportType(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Calendar
            className="mt-3 border-0 p-0"
            mode="single"
            selected={pickerDate}
            defaultMonth={pickerDate ?? selectableEnd}
            onSelect={handleSelect}
            disabled={{ after: selectableEnd }}
            captionLayout="dropdown"
            fixedWeeks
            showOutsideDays
            initialFocus
            ISOWeek={reportType === "WEEKLY"}
            showWeekNumber={reportType === "WEEKLY"}
          />
        </Popover.Panel>
      )}
    </Popover>
  );
}
