/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import useSWR from "swr";
// plane imports
import { getNumberCount } from "@plane/utils";
// components
import { CountChip } from "@/components/common/count-chip";
import { getNotificationBadgeState, workspaceUnreadNotificationKey } from "@/lib/notification-counts";
// hooks
import { useWorkspaceNotifications } from "@/hooks/store/notifications";

type TNotificationAppSidebarOption = {
  workspaceSlug: string;
};

export const NotificationAppSidebarOption = observer(function NotificationAppSidebarOption(
  props: TNotificationAppSidebarOption
) {
  const { workspaceSlug } = props;
  // hooks
  const { unreadNotificationsCount, getUnreadNotificationsCount } = useWorkspaceNotifications();

  const unreadNotificationKey = workspaceUnreadNotificationKey(workspaceSlug);
  useSWR(unreadNotificationKey, workspaceSlug ? () => getUnreadNotificationsCount(workspaceSlug) : null);

  // derived values
  const { count: totalNotifications, hasMentions } = getNotificationBadgeState(unreadNotificationsCount);

  if (totalNotifications <= 0) return <></>;

  return (
    <div className="ml-auto">
      <CountChip count={`${hasMentions ? `@ ` : ``}${getNumberCount(totalNotifications)}`} />
    </div>
  );
});
