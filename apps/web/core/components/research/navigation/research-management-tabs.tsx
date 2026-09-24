/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import Link from "next/link";
// plane imports
import { RESEARCH_SETTINGS_NAVIGATION_ITEMS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { TabNavigationItem, TabNavigationList } from "@plane/propel/tab-navigation";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  currentKey: string;
};

const TAB_PATHS: Record<string, string> = {
  audit: "settings/audit",
  integrations: "settings/integrations",
};

/**
 * Secondary tabs for the IA v2 research management destination. Capability and
 * section filtering reuse the legacy first-level navigation rules.
 */
export const ResearchManagementTabs = observer(function ResearchManagementTabs({ currentKey }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const sections = research.identity?.sections;
  const workspaceSlug = research.identityWorkspaceSlug;
  if (!workspaceSlug) return null;

  const visibleTabs = RESEARCH_SETTINGS_NAVIGATION_ITEMS.filter(
    (item) => Boolean(sections?.[item.section]) && research.canSee(item.key)
  );
  // Platform configuration remains the recovery path when the whole module is
  // disabled and every section switch is therefore false.
  if (visibleTabs.length === 0 && currentKey === "platform" && research.isResearchAdmin) {
    return (
      <nav aria-label={t("research.nav.management")} className="overflow-x-auto border-b border-subtle px-5">
        <TabNavigationList className="py-2">
          <TabNavigationItem isActive>
            <span aria-current="page" className="whitespace-nowrap">
              {t("research.nav.platform")}
            </span>
          </TabNavigationItem>
        </TabNavigationList>
      </nav>
    );
  }

  return (
    <nav aria-label={t("research.nav.management")} className="overflow-x-auto border-b border-subtle px-5">
      <TabNavigationList className="py-2">
        {visibleTabs.map((item) => {
          const path = TAB_PATHS[item.key] ?? `settings/${item.key}`;
          return (
            <Link
              key={item.key}
              href={`/${workspaceSlug}/research/${path}`}
              aria-current={item.key === currentKey ? "page" : undefined}
              className="whitespace-nowrap"
            >
              <TabNavigationItem isActive={item.key === currentKey}>{t(item.labelKey)}</TabNavigationItem>
            </Link>
          );
        })}
      </TabNavigationList>
    </nav>
  );
});
