/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
// plane imports
import { PROJECT_SETTINGS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs } from "@plane/ui";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { DetailBackLink } from "@/components/common/detail-back-link";
import { SettingsPageHeader } from "@/components/settings/page-header";
import { PROJECT_SETTINGS_ICONS } from "@/components/settings/project/sidebar/item-icon";

export const GeneralProjectSettingsHeader = observer(function GeneralProjectSettingsHeader() {
  // translation
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  // derived values
  const settingsDetails = PROJECT_SETTINGS.general;
  const Icon = PROJECT_SETTINGS_ICONS.general;

  return (
    <SettingsPageHeader
      leftItem={
        <div className="flex items-center gap-2">
          <DetailBackLink href={`/${workspaceSlug}/settings/projects`}>返回项目设置列表</DetailBackLink>
          <Breadcrumbs>
            <Breadcrumbs.Item
              component={
                <BreadcrumbLink
                  label={t(settingsDetails.i18n_label)}
                  icon={<Icon className="size-4 text-tertiary" />}
                />
              }
            />
          </Breadcrumbs>
        </div>
      }
    />
  );
});
