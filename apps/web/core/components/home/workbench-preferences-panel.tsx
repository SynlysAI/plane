"use client";

import { useTranslation } from "@plane/i18n";
import type { THomeWidgetSize, THomeWorkbenchDensity, TWorkbenchWidgetKey } from "@plane/types";
import { cn } from "@plane/utils";

const SIZE_OPTIONS: { value: THomeWidgetSize; labelKey: string }[] = [
  { value: "small", labelKey: "research.home_workbench.size_small" },
  { value: "medium", labelKey: "research.home_workbench.size_medium" },
  { value: "large", labelKey: "research.home_workbench.size_large" },
  { value: "full", labelKey: "research.home_workbench.size_full" },
];

const DENSITY_OPTIONS: { value: THomeWorkbenchDensity; labelKey: string }[] = [
  { value: "compact", labelKey: "research.home_workbench.density_compact" },
  { value: "detailed", labelKey: "research.home_workbench.density_detailed" },
];

type TWidgetState = {
  key: TWorkbenchWidgetKey;
  titleKey: string;
  hintKey: string;
  is_enabled: boolean;
  size: THomeWidgetSize;
};

type Props = {
  widgets: TWidgetState[];
  density: THomeWorkbenchDensity;
  saving: boolean;
  syncError: string | null;
  onToggle: (key: TWorkbenchWidgetKey, enabled: boolean) => void;
  onMove: (key: TWorkbenchWidgetKey, direction: -1 | 1) => void;
  onSizeChange: (key: TWorkbenchWidgetKey, size: THomeWidgetSize) => void;
  onDensityChange: (density: THomeWorkbenchDensity) => void;
  onReset: () => void;
};

/** 首页控件编辑面板：显隐、顺序、宽度与密度即时保存。 */
export function WorkbenchPreferencesPanel({
  widgets,
  density,
  saving,
  syncError,
  onToggle,
  onMove,
  onSizeChange,
  onDensityChange,
  onReset,
}: Props) {
  const { t } = useTranslation();

  return (
    <section
      aria-label={t("research.home_workbench.customize_workbench")}
      className="rounded-xl border border-subtle bg-surface-2 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-14 font-semibold text-primary">{t("research.home_workbench.customize_workbench")}</h2>
          <p className="mt-1 text-12 text-tertiary">{t("research.home_workbench.customize_hint")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex overflow-hidden rounded-md border border-subtle"
            role="group"
            aria-label={t("research.home_workbench.density_label")}
          >
            {DENSITY_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={density === option.value}
                className={cn(
                  "px-2.5 py-1.5 text-12 transition-colors",
                  density === option.value ? "bg-surface-1 text-primary" : "text-secondary hover:bg-surface-1"
                )}
                onClick={() => onDensityChange(option.value)}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="rounded-md border border-subtle px-2.5 py-1.5 text-12 text-secondary transition-colors hover:bg-surface-1"
            onClick={onReset}
          >
            {t("research.home_workbench.reset_layout")}
          </button>
        </div>
      </div>

      <div className="mt-4 divide-y divide-subtle" role="list">
        {widgets.map((widget, index) => (
          <div key={widget.key} className="grid gap-3 py-3 lg:grid-cols-[minmax(0,1fr)_auto]" role="listitem">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex min-w-0 items-center gap-2 text-13 font-medium text-primary">
                  <input
                    type="checkbox"
                    checked={widget.is_enabled}
                    onChange={(event) => onToggle(widget.key, event.target.checked)}
                    className="size-3.5 accent-current"
                  />
                  <span className="truncate">{t(widget.titleKey)}</span>
                </label>
                <span className="text-11 text-tertiary">{t(widget.hintKey)}</span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1">
                {SIZE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={widget.size === option.value}
                    className={cn(
                      "rounded-sm border border-transparent px-2 py-1 text-11 transition-colors",
                      widget.size === option.value
                        ? "border-subtle bg-surface-1 text-primary"
                        : "text-secondary hover:bg-surface-1"
                    )}
                    onClick={() => onSizeChange(widget.key, option.value)}
                  >
                    {t(option.labelKey)}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-start gap-1">
              <button
                type="button"
                aria-label={t("research.home_workbench.move_up")}
                disabled={index === 0}
                className="rounded-sm border border-subtle px-2 py-1 text-12 text-secondary transition-colors hover:bg-surface-1 disabled:opacity-40"
                onClick={() => onMove(widget.key, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                aria-label={t("research.home_workbench.move_down")}
                disabled={index === widgets.length - 1}
                className="rounded-sm border border-subtle px-2 py-1 text-12 text-secondary transition-colors hover:bg-surface-1 disabled:opacity-40"
                onClick={() => onMove(widget.key, 1)}
              >
                ↓
              </button>
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-11 text-tertiary">
        {saving ? t("research.home_workbench.preferences_saving") : t("research.home_workbench.preferences_saved")}
        {syncError ? ` · ${t(`research.home_workbench.${syncError}`)}` : ""}
      </p>
    </section>
  );
}
