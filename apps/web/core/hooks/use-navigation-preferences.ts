/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import type {
  TPersonalNavigationItemKey,
  TPersonalNavigationPreferences,
  TProjectNavigationPreferences,
  TProjectNavigationMode,
  TWorkspaceNavigationPreferences,
  TWorkspaceNavigationItemState,
  TAppRailPreferences,
  TAppRailDisplayMode,
} from "@plane/types";
import {
  DEFAULT_PERSONAL_PREFERENCES,
  DEFAULT_PROJECT_PREFERENCES,
  DEFAULT_WORKSPACE_PREFERENCES,
  DEFAULT_APP_RAIL_PREFERENCES,
} from "@plane/types";
import { useWorkspace } from "./store/use-workspace";
import useLocalStorage from "./use-local-storage";

const APP_RAIL_PREFERENCES_KEY = "app_rail_preferences";

export const usePersonalNavigationPreferences = () => {
  const { workspaceSlug } = useParams();
  const { getNavigationPreferences, updateBulkSidebarPreferences } = useWorkspace();

  // Get preferences from the store
  const storePreferences = getNavigationPreferences(workspaceSlug?.toString() || "");

  // Convert store format to hook format for personal items
  const preferences: TPersonalNavigationPreferences = useMemo(() => {
    if (!storePreferences) {
      return DEFAULT_PERSONAL_PREFERENCES;
    }

    // Extract personal items from the store (stickies, your_work, drafts)
    const personalItems: Record<TPersonalNavigationItemKey, { enabled: boolean; sort_order: number }> = {
      stickies: {
        enabled: storePreferences.stickies?.is_pinned ?? DEFAULT_PERSONAL_PREFERENCES.items.stickies.enabled,
        sort_order: storePreferences.stickies?.sort_order ?? DEFAULT_PERSONAL_PREFERENCES.items.stickies.sort_order,
      },
      your_work: {
        enabled: storePreferences.your_work?.is_pinned ?? DEFAULT_PERSONAL_PREFERENCES.items.your_work.enabled,
        sort_order: storePreferences.your_work?.sort_order ?? DEFAULT_PERSONAL_PREFERENCES.items.your_work.sort_order,
      },
      drafts: {
        enabled: storePreferences.drafts?.is_pinned ?? DEFAULT_PERSONAL_PREFERENCES.items.drafts.enabled,
        sort_order: storePreferences.drafts?.sort_order ?? DEFAULT_PERSONAL_PREFERENCES.items.drafts.sort_order,
      },
    };

    return {
      items: personalItems,
    };
  }, [storePreferences]);

  const togglePersonalItem = useCallback(
    async (key: TPersonalNavigationItemKey, enabled: boolean) => {
      if (!workspaceSlug) return;

      const currentItem = preferences.items[key] || { enabled: false, sort_order: 0 };

      await updateBulkSidebarPreferences(workspaceSlug.toString(), [
        {
          key,
          is_pinned: enabled,
          sort_order: currentItem.sort_order,
        },
      ]);
    },
    [workspaceSlug, preferences, updateBulkSidebarPreferences]
  );

  const updatePersonalItemOrder = useCallback(
    async (items: Array<{ key: TPersonalNavigationItemKey; sortOrder: number }>) => {
      if (!workspaceSlug) return;

      const bulkData = items.map((item) => {
        const currentItem = preferences.items[item.key] || { enabled: true, sort_order: 0 };
        return {
          key: item.key,
          is_pinned: currentItem.enabled,
          sort_order: item.sortOrder,
        };
      });

      await updateBulkSidebarPreferences(workspaceSlug.toString(), bulkData);
    },
    [workspaceSlug, preferences, updateBulkSidebarPreferences]
  );

  const isPersonalItemEnabled = useCallback(
    (key: TPersonalNavigationItemKey): boolean => preferences.items[key]?.enabled ?? true,
    [preferences]
  );

  return {
    preferences,
    togglePersonalItem,
    updatePersonalItemOrder,
    isPersonalItemEnabled,
  };
};

/** The project feature bar is fixed; old preference values no longer change layout. */
export const useProjectNavigationPreferences = (): { preferences: TProjectNavigationPreferences } => ({
  preferences: { navigationMode: "TABBED" as const, limitedProjectsCount: 0, showLimitedProjects: false },
});

export const useWorkspaceNavigationPreferences = () => {
  const { workspaceSlug } = useParams();
  const { getNavigationPreferences, updateBulkSidebarPreferences } = useWorkspace();

  // Get preferences from the store
  const storePreferences = getNavigationPreferences(workspaceSlug?.toString() || "");

  // Convert store format to hook format
  const preferences: TWorkspaceNavigationPreferences = useMemo(() => {
    if (!storePreferences) {
      return DEFAULT_WORKSPACE_PREFERENCES;
    }

    return {
      items: storePreferences,
    };
  }, [storePreferences]);

  const toggleWorkspaceItem = useCallback(
    async (key: string, isPinned: boolean) => {
      if (!workspaceSlug) return;

      const currentItem = preferences.items[key] || { is_pinned: false, sort_order: 0 };

      await updateBulkSidebarPreferences(workspaceSlug.toString(), [
        {
          key,
          is_pinned: isPinned,
          sort_order: currentItem.sort_order,
        },
      ]);
    },
    [workspaceSlug, preferences, updateBulkSidebarPreferences]
  );

  const updateWorkspaceItemOrder = useCallback(
    async (items: Array<{ key: string; sortOrder: number }>) => {
      if (!workspaceSlug) return;

      const bulkData = items.map((item) => {
        const currentItem = preferences.items[item.key] || { is_pinned: true, sort_order: 0 };
        return {
          key: item.key,
          is_pinned: currentItem.is_pinned,
          sort_order: item.sortOrder,
        };
      });

      await updateBulkSidebarPreferences(workspaceSlug.toString(), bulkData);
    },
    [workspaceSlug, preferences, updateBulkSidebarPreferences]
  );

  const getWorkspaceItemState = useCallback(
    (key: string): TWorkspaceNavigationItemState => preferences.items[key] || { is_pinned: false, sort_order: 0 },
    [preferences]
  );

  const isWorkspaceItemPinned = useCallback(
    (key: string): boolean => {
      const state = getWorkspaceItemState(key);
      return state.is_pinned;
    },
    [getWorkspaceItemState]
  );

  const updateWorkspaceItemSortOrder = useCallback(
    async (key: string, sortOrder: number) => {
      if (!workspaceSlug) return;

      const currentItem = preferences.items[key] || { is_pinned: false, sort_order: 0 };

      await updateBulkSidebarPreferences(workspaceSlug.toString(), [
        {
          key,
          is_pinned: currentItem.is_pinned,
          sort_order: sortOrder,
        },
      ]);
    },
    [workspaceSlug, preferences, updateBulkSidebarPreferences]
  );

  return {
    preferences,
    toggleWorkspaceItem,
    updateWorkspaceItemOrder,
    updateWorkspaceItemSortOrder,
    getWorkspaceItemState,
    isWorkspaceItemPinned,
  };
};

export const useAppRailPreferences = () => {
  const { storedValue, setValue } = useLocalStorage<TAppRailPreferences>(
    APP_RAIL_PREFERENCES_KEY,
    DEFAULT_APP_RAIL_PREFERENCES
  );

  const updateDisplayMode = useCallback(
    (mode: TAppRailDisplayMode) => {
      setValue({
        displayMode: mode,
      });
    },
    [setValue]
  );

  const toggleDisplayMode = useCallback(() => {
    const currentPreferences = storedValue || DEFAULT_APP_RAIL_PREFERENCES;
    const newMode = currentPreferences.displayMode === "icon_only" ? "icon_with_label" : "icon_only";
    updateDisplayMode(newMode);
  }, [storedValue, updateDisplayMode]);

  return {
    preferences: storedValue || DEFAULT_APP_RAIL_PREFERENCES,
    updateDisplayMode,
    toggleDisplayMode,
  };
};
