/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Suspense } from "react";
import { observer } from "mobx-react";
// plane imports
import { ScrollArea } from "@plane/propel/scrollarea";
import type { TProfileSettingsTabs } from "@plane/types";
import { cn } from "@plane/utils";
// local imports
import { PROFILE_SETTINGS_PAGES_MAP } from "./pages";

type Props = {
  activeTab: TProfileSettingsTabs;
  className?: string;
  inModal?: boolean;
};

export const ProfileSettingsContent = observer(function ProfileSettingsContent(props: Props) {
  const { activeTab, className, inModal = false } = props;
  const PageComponent = PROFILE_SETTINGS_PAGES_MAP[activeTab];

  return (
    <ScrollArea
      className={cn("shrink-0 overflow-y-scroll bg-surface-1", !inModal && "workspace-content-inset", className)}
      viewportClassName="px-8 py-9"
      scrollType="hover"
      orientation="vertical"
      size="sm"
    >
      <Suspense>
        <PageComponent inModal={inModal} />
      </Suspense>
    </ScrollArea>
  );
});
