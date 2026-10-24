"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
// plane imports
import type {
  THomeWidgetKeys,
  THomeWidgetSize,
  THomeWorkbenchDensity,
  TWidgetEntityData,
  TWorkbenchWidgetKey,
} from "@plane/types";
// services
import { WorkspaceService } from "@/services/workspace.service";

const workspaceService = new WorkspaceService();
const LEGACY_DENSITY_KEY = "plane.home.workbench.density";
const DENSITY_VALUES = new Set<THomeWorkbenchDensity>(["compact", "detailed"]);
const SIZE_VALUES = new Set<THomeWidgetSize>(["small", "medium", "large", "full"]);
const LAYOUT_KEY: THomeWidgetKeys = "workbench_layout";

export const WORKBENCH_WIDGET_CATALOG: {
  key: TWorkbenchWidgetKey;
  titleKey: string;
  hintKey: string;
  defaultSize: THomeWidgetSize;
}[] = [
  {
    key: "my_todos",
    titleKey: "research.home_workbench.widget_my_todos",
    hintKey: "research.home_workbench.widget_my_todos_hint",
    defaultSize: "medium",
  },
  {
    key: "research_projects",
    titleKey: "research.home_workbench.widget_research_projects",
    hintKey: "research.home_workbench.widget_research_projects_hint",
    defaultSize: "large",
  },
  {
    key: "administrative_projects",
    titleKey: "research.home_workbench.widget_administrative_projects",
    hintKey: "research.home_workbench.widget_administrative_projects_hint",
    defaultSize: "small",
  },
  {
    key: "recent_activity",
    titleKey: "research.home_workbench.widget_recent_activity",
    hintKey: "research.home_workbench.widget_recent_activity_hint",
    defaultSize: "small",
  },
  {
    key: "report_summary",
    titleKey: "research.home_workbench.widget_report_summary",
    hintKey: "research.home_workbench.widget_report_summary_hint",
    defaultSize: "small",
  },
];

const DEFAULT_WIDGET_MAP = new Map(
  WORKBENCH_WIDGET_CATALOG.map((widget, index) => [
    widget.key,
    {
      key: widget.key,
      is_enabled: true,
      config: { size: widget.defaultSize },
      sort_order: WORKBENCH_WIDGET_CATALOG.length * 100 - index * 100,
    },
  ])
);

/** 读取并按用户维度持久化首页控件显隐、顺序、宽度和密度。 */
export function useHomeWorkbenchPreferences(workspaceSlug: string, availableKeys: TWorkbenchWidgetKey[]) {
  const availableKeySet = useMemo(() => new Set(availableKeys), [availableKeys]);
  const {
    data: preferenceRows,
    isLoading,
    error,
    mutate,
  } = useSWR(
    workspaceSlug ? ["WORKSPACE_HOME_WORKBENCH_PREFERENCES", workspaceSlug] : null,
    workspaceSlug ? () => workspaceService.fetchWorkspaceWidgets(workspaceSlug) : null,
    { revalidateIfStale: false, revalidateOnFocus: false, revalidateOnReconnect: false }
  );
  const [density, setDensityState] = useState<THomeWorkbenchDensity>("compact");
  const [syncError, setSyncError] = useState<string | null>(null);
  const [savingCount, setSavingCount] = useState(0);
  const densityHydrated = useRef(false);
  const saveQueue = useRef(Promise.resolve());

  const widgets = useMemo(() => {
    const rows = new Map(preferenceRows?.map((row) => [row.key as string, row]) ?? []);
    return (
      WORKBENCH_WIDGET_CATALOG.map((catalog) => {
        const row = rows.get(catalog.key);
        const fallback = DEFAULT_WIDGET_MAP.get(catalog.key);
        const configSize = row?.config?.size;
        return {
          key: catalog.key,
          titleKey: catalog.titleKey,
          hintKey: catalog.hintKey,
          is_enabled: row?.is_enabled ?? fallback?.is_enabled ?? true,
          size: SIZE_VALUES.has(configSize as THomeWidgetSize) ? (configSize as THomeWidgetSize) : catalog.defaultSize,
          sort_order: row?.sort_order ?? fallback?.sort_order ?? 0,
        };
      })
        .filter((widget) => availableKeySet.has(widget.key))
        // oxlint-disable-next-line unicorn/no-array-sort -- 当前 TypeScript lib 不支持 toSorted。
        .sort((left, right) => right.sort_order - left.sort_order)
    );
  }, [availableKeySet, preferenceRows]);

  const saveChangedRows = useCallback(
    async (changedRows: TWidgetEntityData[]) => {
      if (!changedRows.length) return;
      const previous = preferenceRows ?? [];
      const previousByKey = new Map(previous.map((row) => [row.key as string, row]));
      for (const changedRow of changedRows) previousByKey.set(changedRow.key as string, changedRow);
      const optimistic = [...previousByKey.values()];

      const save = async () => {
        setSyncError(null);
        setSavingCount((count) => count + 1);
        await mutate(optimistic, { revalidate: false });
        try {
          await Promise.all(
            changedRows.map((changedRow) =>
              workspaceService.updateWorkspaceWidget(workspaceSlug, changedRow.key, {
                is_enabled: changedRow.is_enabled,
                config: changedRow.config,
                sort_order: changedRow.sort_order,
              })
            )
          );
        } catch {
          await mutate(previous, { revalidate: false });
          setSyncError("preferences_sync_error");
        } finally {
          setSavingCount((count) => count - 1);
        }
      };

      const queued = saveQueue.current.then(save, save);
      saveQueue.current = queued;
      await queued;
    },
    [mutate, preferenceRows, workspaceSlug]
  );

  const currentRow = useCallback(
    (key: TWorkbenchWidgetKey) => {
      const row = preferenceRows?.find((item) => item.key === key);
      const widget = widgets.find((item) => item.key === key);
      return {
        key,
        is_enabled: row?.is_enabled ?? widget?.is_enabled ?? true,
        config: row?.config ?? { size: widget?.size ?? "medium" },
        sort_order: row?.sort_order ?? widget?.sort_order ?? 0,
      } satisfies TWidgetEntityData;
    },
    [preferenceRows, widgets]
  );

  const toggleWidget = useCallback(
    async (key: TWorkbenchWidgetKey, isEnabled: boolean) => {
      const row = currentRow(key);
      await saveChangedRows([{ ...row, is_enabled: isEnabled }]);
    },
    [currentRow, saveChangedRows]
  );

  const setWidgetSize = useCallback(
    async (key: TWorkbenchWidgetKey, size: THomeWidgetSize) => {
      const row = currentRow(key);
      await saveChangedRows([{ ...row, config: { ...row.config, size } }]);
    },
    [currentRow, saveChangedRows]
  );

  const moveWidget = useCallback(
    async (key: TWorkbenchWidgetKey, direction: -1 | 1) => {
      const orderedKeys = widgets.map((widget) => widget.key);
      const from = orderedKeys.indexOf(key);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= orderedKeys.length) return;

      let nextSortOrder: number;
      if (direction === -1) {
        const above = widgets[to];
        const aboveAbove = widgets[from - 2];
        nextSortOrder = aboveAbove ? (above.sort_order + aboveAbove.sort_order) / 2 : above.sort_order + 10000;
      } else {
        const below = widgets[to + 1];
        const target = widgets[to];
        nextSortOrder = below ? (target.sort_order + below.sort_order) / 2 : target.sort_order - 10000;
      }
      await saveChangedRows([{ ...currentRow(key), sort_order: nextSortOrder }]);
    },
    [currentRow, saveChangedRows, widgets]
  );

  const resetWidgets = useCallback(async () => {
    const changed = availableKeys.map((key, index) => {
      const catalog = WORKBENCH_WIDGET_CATALOG.find((item) => item.key === key);
      const row = currentRow(key);
      return {
        key,
        is_enabled: true,
        config: { ...row.config, size: catalog?.defaultSize ?? "medium" },
        sort_order: availableKeys.length * 100 - index * 100,
      } satisfies TWidgetEntityData;
    });
    await saveChangedRows(changed);
  }, [availableKeys, currentRow, saveChangedRows]);

  const setDensity = useCallback(
    async (nextDensity: THomeWorkbenchDensity) => {
      setDensityState(nextDensity);
      const row = preferenceRows?.find((item) => item.key === LAYOUT_KEY);
      await saveChangedRows([
        {
          key: LAYOUT_KEY,
          is_enabled: row?.is_enabled ?? true,
          config: { ...row?.config, density: nextDensity },
          sort_order: row?.sort_order ?? 100,
        },
      ]);
    },
    [preferenceRows, saveChangedRows]
  );

  useEffect(() => {
    if (isLoading) return;
    if (densityHydrated.current) return;
    const row = preferenceRows?.find((item) => item.key === LAYOUT_KEY);
    const stored = row?.config?.density;
    if (DENSITY_VALUES.has(stored as THomeWorkbenchDensity)) {
      const serverDensity = stored as THomeWorkbenchDensity;
      setDensityState(serverDensity);
      densityHydrated.current = true;
      return;
    }
    if (typeof window === "undefined") return;
    const legacy = window.localStorage.getItem(LEGACY_DENSITY_KEY);
    if (DENSITY_VALUES.has(legacy as THomeWorkbenchDensity)) {
      setDensityState(legacy as THomeWorkbenchDensity);
      densityHydrated.current = true;
    }
  }, [isLoading, preferenceRows]);

  return {
    loading: isLoading,
    error,
    syncError,
    saving: savingCount > 0,
    widgets,
    // 偏好未返回前不触发隐藏控件的数据请求，避免默认布局闪现和多余 API 调用。
    enabledWidgets: isLoading ? [] : widgets.filter((widget) => widget.is_enabled),
    density,
    toggleWidget,
    setWidgetSize,
    moveWidget,
    resetWidgets,
    setDensity,
  };
}
