/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type React from "react";
import { useEffect } from "react";
import { Cpu, type LucideIcon } from "lucide-react";
import { KeyOutline, LockOutline, SettingsOutline, SubscribeOutline, UserOutline } from "@makeplane/propel/icons";
import { observer } from "mobx-react";
import { useParams } from "react-router";
// plane imports
import {
  GROUPED_PROFILE_SETTINGS,
  PROFILE_SETTINGS_CATEGORIES,
  PROFILE_SETTINGS_CATEGORY_LABELS,
} from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { ISvgIcons } from "@plane/propel/icons";
import type { TProfileSettingsTabs } from "@plane/types";
// local imports
import { SettingsSidebarItem } from "../../sidebar/item";
import { useResearch } from "@/hooks/store/use-research";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useUser } from "@/hooks/store/user";
import { ProfileSettingsSidebarWorkspaceOptions } from "./workspace-options";

const ICONS: Record<TProfileSettingsTabs, LucideIcon | React.FC<ISvgIcons>> = {
  general: UserOutline,
  security: LockOutline,
  preferences: SettingsOutline,
  notifications: SubscribeOutline,
  "api-tokens": KeyOutline,
  "agent-configuration": Cpu,
};

type Props = {
  activeTab: TProfileSettingsTabs;
  updateActiveTab: (tab: TProfileSettingsTabs) => void;
};

export const ProfileSettingsSidebarItemCategories = observer(function ProfileSettingsSidebarItemCategories(
  props: Props
) {
  const { activeTab, updateActiveTab } = props;
  // params
  const { profileTabId } = useParams();
  // translation
  const { t } = useTranslation();
  const research = useResearch();
  const workspace = useWorkspace();
  const { data: currentUser } = useUser();
  const currentWorkspaceSlug = workspace.currentWorkspace?.slug;
  const identityWorkspaceSlug = research.identityWorkspaceSlug;
  const fetchIdentity = research.fetchIdentity;
  const identityLoader = research.identityLoader;
  useEffect(() => {
    if (currentWorkspaceSlug && currentUser?.id && !identityLoader && identityWorkspaceSlug !== currentWorkspaceSlug) {
      void fetchIdentity(currentWorkspaceSlug).catch(() => undefined);
    }
  }, [currentUser?.id, currentWorkspaceSlug, fetchIdentity, identityLoader, identityWorkspaceSlug]);
  const identityReady = Boolean(currentWorkspaceSlug && research.identityWorkspaceSlug === currentWorkspaceSlug);
  const showAgentConfiguration = identityReady && research.canConfigurePersonalAgentBackend;

  return (
    <div className="mt-4 flex flex-col gap-y-4">
      {PROFILE_SETTINGS_CATEGORIES.map((category) => {
        const categoryItems = GROUPED_PROFILE_SETTINGS[category];

        if (categoryItems.length === 0) return null;

        return (
          <div key={category} className="shrink-0">
            <div className="p-2 text-caption-md-medium text-tertiary capitalize">
              {t(PROFILE_SETTINGS_CATEGORY_LABELS[category])}
            </div>
            <div className="flex flex-col">
              {categoryItems
                .filter((item) => item.key !== "agent-configuration" || showAgentConfiguration)
                .map((item) => (
                  <SettingsSidebarItem
                    key={item.key}
                    as="button"
                    onClick={() => updateActiveTab(item.key)}
                    isActive={activeTab === item.key}
                    icon={ICONS[item.key]}
                    label={t(item.i18n_label)}
                  />
                ))}
            </div>
          </div>
        );
      })}
      {profileTabId && <ProfileSettingsSidebarWorkspaceOptions />}
    </div>
  );
});
