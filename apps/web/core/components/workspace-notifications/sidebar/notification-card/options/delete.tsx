/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { DeleteOutline } from "@makeplane/propel/icons";
// plane imports
import { useTranslation } from "@plane/i18n";
import { AlertModalCore } from "@plane/ui";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
// store
import type { INotification } from "@/store/notifications/notification";
// local imports
import { NotificationItemOptionButton } from "./button";

type TNotificationItemDeleteOption = {
  workspaceSlug: string;
  notification: INotification;
};

export const NotificationItemDeleteOption = observer(function NotificationItemDeleteOption(
  props: TNotificationItemDeleteOption
) {
  const { workspaceSlug, notification } = props;
  const { deleteNotification } = notification;
  const { t } = useTranslation();
  const [isDeleting, setIsDeleting] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteNotification(workspaceSlug);
      setToast({
        title: t("notification.announcement.toasts.deleted"),
        type: TOAST_TYPE.SUCCESS,
      });
      setIsConfirmOpen(false);
    } catch (error) {
      console.error(error);
      setToast({
        title: t("notification.announcement.toasts.delete_failed"),
        type: TOAST_TYPE.ERROR,
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <NotificationItemOptionButton
        tooltipContent={t("notification.announcement.options.delete")}
        callBack={() => setIsConfirmOpen(true)}
      >
        <DeleteOutline className="h-3 w-3 text-tertiary" />
      </NotificationItemOptionButton>
      <AlertModalCore
        handleClose={() => !isDeleting && setIsConfirmOpen(false)}
        handleSubmit={handleDelete}
        isSubmitting={isDeleting}
        isOpen={isConfirmOpen}
        title={t("notification.announcement.delete.title")}
        content={<>{t("notification.announcement.delete.content")}</>}
        primaryButtonText={{
          default: t("notification.announcement.delete.confirm"),
          loading: t("notification.announcement.delete.loading"),
        }}
        secondaryButtonText={t("common.cancel")}
      />
    </>
  );
});
