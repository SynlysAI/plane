/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { RESEARCH_SETTINGS_NAVIGATION_ITEMS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { TabNavigationList } from "@plane/propel/tab-navigation";
import { ResearchTabLink } from "@/components/research/common/research-tab-link";
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
      <nav
        aria-label={t("research.nav.management")}
        className="overflow-x-auto border-b border-subtle bg-surface-1 px-5"
      >
        <TabNavigationList className="py-2">
          <span aria-current="page" className="text-13 font-medium whitespace-nowrap text-primary">
            {t("research.nav.platform")}
          </span>
        </TabNavigationList>
      </nav>
    );
  }

  return (
    <nav aria-label={t("research.nav.management")} className="overflow-x-auto border-b border-subtle bg-surface-1 px-5">
      <TabNavigationList className="py-2">
        {visibleTabs.map((item) => {
          const path = TAB_PATHS[item.key] ?? `settings/${item.key}`;
          return (
            <ResearchTabLink
              key={item.key}
              href={`/${workspaceSlug}/research/${path}`}
              isActive={item.key === currentKey}
            >
              {t(item.labelKey)}
            </ResearchTabLink>
          );
        })}
      </TabNavigationList>
    </nav>
  );
});
