/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useMemo } from "react";
import { useParams } from "next/navigation";
import { observer } from "mobx-react";
import { ChevronRightOutline, MoreHorizontalOutline } from "@makeplane/propel/icons";
import { Disclosure, Transition } from "@headlessui/react";
// plane imports
import {
  RESEARCH_IA_V2_NAVIGATION_ITEMS,
  RESEARCH_SETTINGS_NAVIGATION_ITEMS,
  WORKSPACE_SIDEBAR_DYNAMIC_NAVIGATION_ITEMS_LINKS,
  WORKSPACE_SIDEBAR_STATIC_NAVIGATION_ITEMS,
  WORKSPACE_SIDEBAR_STATIC_NAVIGATION_ITEMS_LINKS,
  WORKSPACE_SIDEBAR_STATIC_PINNED_NAVIGATION_ITEMS_LINKS,
} from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { cn } from "@plane/utils";
// components
import { SidebarNavItem } from "@/components/sidebar/sidebar-navigation";
// store hooks
import { useAppTheme } from "@/hooks/store/use-app-theme";
import useLocalStorage from "@/hooks/use-local-storage";
import {
  usePersonalNavigationPreferences,
  useWorkspaceNavigationPreferences,
} from "@/hooks/use-navigation-preferences";
import { useResearch } from "@/hooks/store/use-research";
import { SidebarItemBase } from "./sidebar-item";

export const SidebarMenuItems = observer(function SidebarMenuItems() {
  const { workspaceSlug } = useParams();
  // routers
  const { setValue: toggleWorkspaceMenu, storedValue: isWorkspaceMenuOpen } = useLocalStorage<boolean>(
    "is_workspace_menu_open",
    true
  );

  // store hooks
  const { isExtendedSidebarOpened, toggleExtendedSidebar } = useAppTheme();
  const research = useResearch();
  // hooks
  const { preferences: personalPreferences } = usePersonalNavigationPreferences();
  const { preferences: workspacePreferences } = useWorkspaceNavigationPreferences();
  // translation
  const { t } = useTranslation();

  const toggleListDisclosure = (isOpen: boolean) => {
    toggleWorkspaceMenu(isOpen);
  };
  // IA v2 把项目 / 视图 / 分析 / 归档收敛到行政项目容器。
  const usesResearchIaV2 = research.isEnabled && research.isIaV2Enabled;
  const sections = research.identity?.sections;
  const visibleIaV2Items =
    usesResearchIaV2 && research.identityWorkspaceSlug === workspaceSlug
      ? RESEARCH_IA_V2_NAVIGATION_ITEMS.filter((item) => {
          if (item.key === "research_chain") return false;
          if (item.key === "management") {
            return RESEARCH_SETTINGS_NAVIGATION_ITEMS.some(
              (setting) => Boolean(sections?.[setting.section]) && research.canSee(setting.key)
            );
          }
          return Boolean(sections?.[item.section]) && research.canSee(item.key);
        })
      : [];

  // Filter static navigation items based on personal preferences
  const filteredStaticNavigationItems = useMemo(() => {
    // IA v2 keeps global destinations together above the scoped project trees.
    if (usesResearchIaV2) return [WORKSPACE_SIDEBAR_STATIC_NAVIGATION_ITEMS["home"]];
    const items = [...WORKSPACE_SIDEBAR_STATIC_NAVIGATION_ITEMS_LINKS];
    const personalItems: Array<(typeof items)[0] & { sort_order: number }> = [];

    // Add personal items based on preferences with their sort_order
    const stickiesItem = WORKSPACE_SIDEBAR_STATIC_NAVIGATION_ITEMS["stickies"];
    if (personalPreferences.items.stickies?.enabled && stickiesItem) {
      personalItems.push({
        ...stickiesItem,
        sort_order: personalPreferences.items.stickies.sort_order,
      });
    }
    if (personalPreferences.items.your_work?.enabled && WORKSPACE_SIDEBAR_STATIC_NAVIGATION_ITEMS["your-work"]) {
      personalItems.push({
        ...WORKSPACE_SIDEBAR_STATIC_NAVIGATION_ITEMS["your-work"],
        sort_order: personalPreferences.items.your_work.sort_order,
      });
    }
    if (personalPreferences.items.drafts?.enabled && WORKSPACE_SIDEBAR_STATIC_NAVIGATION_ITEMS["drafts"]) {
      personalItems.push({
        ...WORKSPACE_SIDEBAR_STATIC_NAVIGATION_ITEMS["drafts"],
        sort_order: personalPreferences.items.drafts.sort_order,
      });
    }

    // Sort personal items by sort_order
    personalItems.sort((a, b) => a.sort_order - b.sort_order);

    // Merge static items with sorted personal items
    return [...items, ...personalItems];
  }, [personalPreferences, usesResearchIaV2]);

  const sortedNavigationItems = useMemo(
    () =>
      // oxlint-disable-next-line oxc/no-map-spread
      WORKSPACE_SIDEBAR_DYNAMIC_NAVIGATION_ITEMS_LINKS.map((item) => {
        const preference = workspacePreferences.items[item.key];
        return {
          ...item,
          sort_order: preference ? preference.sort_order : 0,
        };
      }).sort((a, b) => a.sort_order - b.sort_order),
    [workspacePreferences]
  );

  return (
    <>
      <div className="flex shrink-0 flex-col gap-0.5">
        {filteredStaticNavigationItems.map((item, _index) => (
          // oxlint-disable-next-line react/no-array-index-key
          <SidebarItemBase key={`static_${_index}`} item={item} className={usesResearchIaV2 ? "h-8" : undefined} />
        ))}
        {visibleIaV2Items.map((item) => (
          <SidebarItemBase
            key={item.key}
            className="h-8"
            additionalStaticItems={[item.key]}
            item={{
              key: item.key,
              labelTranslationKey: item.labelKey,
              href: `/research/${item.path}`,
              access: WORKSPACE_SIDEBAR_STATIC_NAVIGATION_ITEMS.home.access,
              highlight: (pathname, url) => pathname === url || pathname.startsWith(`${url}/`),
            }}
          />
        ))}
      </div>
      {!usesResearchIaV2 && (
        <Disclosure as="div" className="flex flex-col" defaultOpen={!!isWorkspaceMenuOpen}>
          <div className="group flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-placeholder hover:bg-layer-transparent-hover">
            <Disclosure.Button
              as="button"
              type="button"
              className="flex w-full items-center gap-1 text-left text-13 font-semibold whitespace-nowrap text-placeholder"
              onClick={() => toggleListDisclosure(!isWorkspaceMenuOpen)}
              aria-label={t(
                isWorkspaceMenuOpen
                  ? "aria_labels.app_sidebar.close_workspace_menu"
                  : "aria_labels.app_sidebar.open_workspace_menu"
              )}
            >
              <span className="text-13 font-semibold">{t("common.workspace")}</span>
            </Disclosure.Button>
            <div className="pointer-events-none flex items-center opacity-0 group-hover:pointer-events-auto group-hover:opacity-100">
              <Disclosure.Button
                as="button"
                type="button"
                className="flex-shrink-0 rounded-sm p-0.5 hover:bg-layer-1"
                onClick={() => toggleListDisclosure(!isWorkspaceMenuOpen)}
                aria-label={t(
                  isWorkspaceMenuOpen
                    ? "aria_labels.app_sidebar.close_workspace_menu"
                    : "aria_labels.app_sidebar.open_workspace_menu"
                )}
              >
                <ChevronRightOutline
                  className={cn("size-3 flex-shrink-0 transition-all", {
                    "rotate-90": isWorkspaceMenuOpen,
                  })}
                />
              </Disclosure.Button>
            </div>
          </div>
          <Transition
            as="div"
            show={!!isWorkspaceMenuOpen}
            enter="transition duration-100 ease-out"
            enterFrom="transform scale-95 opacity-0"
            enterTo="transform scale-100 opacity-100"
            leave="transition duration-75 ease-out"
            leaveFrom="transform scale-100 opacity-100"
            leaveTo="transform scale-95 opacity-0"
          >
            {isWorkspaceMenuOpen && (
              <Disclosure.Panel as="div" className="flex flex-col gap-0.5" static>
                <>
                  {WORKSPACE_SIDEBAR_STATIC_PINNED_NAVIGATION_ITEMS_LINKS.map((item, _index) => (
                    // oxlint-disable-next-line react/no-array-index-key
                    <SidebarItemBase key={`static_${_index}`} item={item} />
                  ))}
                  {sortedNavigationItems.map((item, _index) => (
                    // oxlint-disable-next-line react/no-array-index-key
                    <SidebarItemBase key={`dynamic_${_index}`} item={item} />
                  ))}
                  <SidebarNavItem>
                    <button
                      type="button"
                      onClick={() => toggleExtendedSidebar()}
                      className="flex flex-grow items-center gap-1.5 text-13 font-medium text-tertiary"
                      id="extended-sidebar-toggle"
                      aria-label={t(
                        isExtendedSidebarOpened
                          ? "aria_labels.app_sidebar.close_extended_sidebar"
                          : "aria_labels.app_sidebar.open_extended_sidebar"
                      )}
                    >
                      <MoreHorizontalOutline className="size-4 flex-shrink-0" />
                      <span>{isExtendedSidebarOpened ? "Hide" : "More"}</span>
                    </button>
                  </SidebarNavItem>
                </>
              </Disclosure.Panel>
            )}
          </Transition>
        </Disclosure>
      )}
    </>
  );
});
