/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
// plane imports
import { WORKSPACE_SETTINGS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Breadcrumbs } from "@plane/ui";
// components
import { BreadcrumbLink } from "@/components/common/breadcrumb-link";
import { DetailBackLink } from "@/components/common/detail-back-link";
import { SettingsPageHeader } from "@/components/settings/page-header";
import { WORKSPACE_SETTINGS_ICONS } from "@/components/settings/workspace/sidebar/item-icon";

export const WebhookDetailsWorkspaceSettingsHeader = observer(function WebhookDetailsWorkspaceSettingsHeader() {
  // translation
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  // derived values
  const settingsDetails = WORKSPACE_SETTINGS.webhooks;
  const Icon = WORKSPACE_SETTINGS_ICONS.webhooks;

  return (
    <SettingsPageHeader
      leftItem={
        <div className="flex items-center gap-2">
          <DetailBackLink href={`/${workspaceSlug}/settings/webhooks`}>返回 Webhook 列表</DetailBackLink>
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
