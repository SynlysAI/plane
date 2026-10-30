/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useSearchParams } from "react-router";
// plane imports
import { PROFILE_SETTINGS_TABS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import type { TProfileSettingsTabs } from "@plane/types";
// components
import { LogoSpinner } from "@/components/common/logo-spinner";
import { PageHead } from "@/components/core/page-title";
import { ProfileSettingsContent } from "@/components/settings/profile/content";
import { resolveProfileReturnWorkspaceSlug } from "@/components/settings/profile/sidebar/header";
import { ProfileSettingsSidebarRoot } from "@/components/settings/profile/sidebar";
// hooks
import { useUserSettings } from "@/hooks/store/user/user-user-settings";
import { useUser } from "@/hooks/store/user";
import { useAppRouter } from "@/hooks/use-app-router";
import { useWorkspace } from "@/hooks/store/use-workspace";
// local imports
import type { Route } from "../+types/layout";

function ProfileSettingsPage(props: Route.ComponentProps) {
  const { profileTabId } = props.params;
  // router
  const router = useAppRouter();
  // store hooks
  const { data: currentUser } = useUser();
  const { data: userSettings } = useUserSettings();
  const { workspaces } = useWorkspace();
  const [searchParams] = useSearchParams();
  // translation
  const { t } = useTranslation();
  // derived values
  const isAValidTab = PROFILE_SETTINGS_TABS.includes(profileTabId as TProfileSettingsTabs);
  const returnWorkspaceSlug = resolveProfileReturnWorkspaceSlug({
    queryWorkspaceSlug: searchParams.get("workspace") ?? undefined,
    lastWorkspaceSlug: userSettings?.workspace?.last_workspace_slug,
    fallbackWorkspaceSlug: userSettings?.workspace?.fallback_workspace_slug,
    workspaces: Object.values(workspaces ?? {}),
  });

  if (!currentUser || !isAValidTab)
    return (
      <div className="grid size-full place-items-center px-4">
        <LogoSpinner />
      </div>
    );

  return (
    <>
      <PageHead title={`${t("profile.label")} - ${t("general_settings")}`} />
      <div className="relative size-full">
        <div className="flex size-full">
          <ProfileSettingsSidebarRoot
            activeTab={profileTabId as TProfileSettingsTabs}
            className="w-[250px]"
            returnWorkspaceSlug={returnWorkspaceSlug}
            updateActiveTab={(tab) => router.push(`/settings/profile/${tab}`)}
          />
          <ProfileSettingsContent
            activeTab={profileTabId as TProfileSettingsTabs}
            className="mx-auto w-fit max-w-225 grow px-page-x py-20"
          />
        </div>
      </div>
    </>
  );
}

export default observer(ProfileSettingsPage);
