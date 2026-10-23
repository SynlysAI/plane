/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { calculateTimeAgo, renderFormattedDate, renderFormattedTime } from "@plane/utils";
// hooks
import { useNotification } from "@/hooks/store/notifications/use-notification";
// local imports
import {
  NotificationItemDeleteOption,
  NotificationItemReadOption,
} from "@/components/workspace-notifications/sidebar/notification-card/options";

type TSystemAnnouncementDetailProps = {
  workspaceSlug: string;
  notificationId: string;
};

export const SystemAnnouncementDetail = observer(function SystemAnnouncementDetail(
  props: TSystemAnnouncementDetailProps
) {
  const { workspaceSlug, notificationId } = props;
  const notificationStore = useNotification(notificationId);
  const notification = notificationStore.asJson;
  const { t } = useTranslation();
  const announcement = notification.announcement_details;

  if (!notification?.id || !announcement) return <></>;

  const publishedAt = announcement.published_at ?? announcement.created_at;
  const publisher =
    announcement.created_by_details?.display_name ||
    announcement.created_by_details?.first_name ||
    t("notification.announcement.publisher_system");

  return (
    <article className="h-full overflow-y-auto bg-surface-1">
      <header className="sticky top-0 z-[1] border-b border-subtle bg-surface-1 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-11 font-medium tracking-wide text-tertiary uppercase">
              {t("notification.announcement.label")}
            </p>
            <h2 className="mt-1 text-20 font-semibold break-words text-primary">{announcement.title}</h2>
            <p className="mt-1 text-12 text-secondary">
              {publisher}
              {publishedAt && (
                <>
                  {" · "}
                  <time dateTime={publishedAt}>
                    {renderFormattedDate(publishedAt)} {renderFormattedTime(publishedAt, "12-hour")}
                  </time>
                  <span className="text-tertiary"> · {calculateTimeAgo(publishedAt)}</span>
                </>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <NotificationItemReadOption workspaceSlug={workspaceSlug} notification={notificationStore} />
            <NotificationItemDeleteOption workspaceSlug={workspaceSlug} notification={notificationStore} />
          </div>
        </div>
      </header>
      <div className="px-6 py-6">
        <p className="max-w-3xl text-14 leading-6 whitespace-pre-wrap text-primary">{announcement.body}</p>
      </div>
    </article>
  );
});
