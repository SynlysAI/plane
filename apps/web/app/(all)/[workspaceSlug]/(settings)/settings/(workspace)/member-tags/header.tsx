/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { observer } from "mobx-react";
import { WORKSPACE_SETTINGS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs } from "@plane/ui";
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { SettingsPageHeader } from "@/components/settings/page-header";
import { WORKSPACE_SETTINGS_ICONS } from "@/components/settings/workspace/sidebar/item-icon";

export const MemberTagsWorkspaceSettingsHeader = observer(function MemberTagsWorkspaceSettingsHeader() {
  const { t } = useTranslation();
  const settingsDetails = WORKSPACE_SETTINGS["member-tags"];
  const Icon = WORKSPACE_SETTINGS_ICONS["member-tags"];

  return (
    <SettingsPageHeader
      leftItem={
        <Breadcrumbs>
          <Breadcrumbs.Item
            component={
              <BreadcrumbLink label={t(settingsDetails.i18n_label)} icon={<Icon className="size-4 text-tertiary" />} />
            }
          />
        </Breadcrumbs>
      }
    />
  );
});
