/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { EditOutline } from "@makeplane/propel/icons";
import { Field } from "@makeplane/propel/components/field";
import { Input, InputGroup } from "@makeplane/propel/components/input";
import { TextArea, TextAreaGroup } from "@makeplane/propel/components/text-area";
// plane imports
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { AlertModalCore, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import { calculateTimeAgo } from "@plane/utils";
// hooks
import { useWorkspaceNotifications } from "@/hooks/store/notifications";
import { useUserPermissions } from "@/hooks/store/user";

type TSystemAnnouncementComposerProps = {
  workspaceSlug: string;
};

/** Create a client key that keeps retries and duplicate clicks tied to one publish. */
function createIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const SystemAnnouncementComposer = observer(function SystemAnnouncementComposer(
  props: TSystemAnnouncementComposerProps
) {
  const { workspaceSlug } = props;
  const { t } = useTranslation();
  const { allowPermissions } = useUserPermissions();
  const isAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);
  const {
    systemAnnouncements,
    systemAnnouncementLoader,
    systemAnnouncementError,
    getSystemAnnouncements,
    publishSystemAnnouncement,
  } = useWorkspaceNotifications();

  const [isOpen, setIsOpen] = useState(false);
  const [isPreview, setIsPreview] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(createIdempotencyKey);

  const isPublishing = systemAnnouncementLoader === "publishing";
  const canPreview = Boolean(title.trim() && body.trim());

  useEffect(() => {
    if (!isOpen || !isAdmin) return;
    getSystemAnnouncements(workspaceSlug).catch((error) => console.error(error));
  }, [getSystemAnnouncements, isAdmin, isOpen, workspaceSlug]);

  if (!isAdmin) return <></>;

  /** Open the composer while leaving any previous preview state behind. */
  const openComposer = () => {
    setIsPreview(false);
    setIsOpen(true);
  };

  /** Close the composer and its confirmation without clearing a failed draft. */
  const closeComposer = () => {
    setIsOpen(false);
    setIsPreview(false);
    setIsConfirmOpen(false);
  };

  /** Clear a successfully published draft and prepare a fresh idempotency key. */
  const resetComposer = () => {
    setTitle("");
    setBody("");
    setIdempotencyKey(createIdempotencyKey());
    setIsPreview(false);
  };

  /** Publish the confirmed draft and refresh inbox data through the store. */
  const handlePublish = async () => {
    try {
      const announcement = await publishSystemAnnouncement(workspaceSlug, {
        title: title.trim(),
        body: body.trim(),
        idempotency_key: idempotencyKey,
      });
      setToast({
        title: t("notification.announcement.toasts.published"),
        message: t("notification.announcement.toasts.published_count", {
          count: announcement?.recipient_count ?? 0,
        }),
        type: TOAST_TYPE.SUCCESS,
      });
      resetComposer();
      closeComposer();
    } catch (error) {
      console.error(error);
      setToast({
        title: t("notification.announcement.toasts.publish_failed"),
        type: TOAST_TYPE.ERROR,
      });
    }
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={openComposer}>
        <EditOutline className="size-3.5" />
        {t("notification.announcement.compose")}
      </Button>

      <ModalCore
        isOpen={isOpen}
        handleClose={isPublishing ? () => undefined : closeComposer}
        position={EModalPosition.TOP}
        width={EModalWidth.XXL}
      >
        <div className="flex max-h-[80vh] flex-col">
          <div className="border-b border-subtle px-5 py-4">
            <h3 className="text-16 font-semibold text-primary">{t("notification.announcement.compose_title")}</h3>
            <p className="mt-1 text-12 text-tertiary">{t("notification.announcement.compose_hint")}</p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {isPreview ? (
              <section aria-label={t("notification.announcement.preview")}>
                <h4 className="text-15 font-semibold break-words text-primary">{title.trim()}</h4>
                <p className="mt-3 text-14 leading-6 whitespace-pre-wrap text-primary">{body.trim()}</p>
              </section>
            ) : (
              <div className="space-y-4">
                <Field name="announcement-title">
                  <InputGroup size="xl">
                    <Input
                      size="xl"
                      id="announcement-title"
                      value={title}
                      maxLength={255}
                      placeholder={t("notification.announcement.title_placeholder")}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </InputGroup>
                </Field>
                <Field name="announcement-body">
                  <TextAreaGroup resize="none">
                    <TextArea
                      size="lg"
                      surface="field"
                      id="announcement-body"
                      value={body}
                      rows={8}
                      placeholder={t("notification.announcement.body_placeholder")}
                      onChange={(event) => setBody(event.target.value)}
                    />
                  </TextAreaGroup>
                </Field>
              </div>
            )}

            <section className="mt-6 border-t border-subtle pt-4" aria-label={t("notification.announcement.published")}>
              <h4 className="text-13 font-semibold text-primary">{t("notification.announcement.published")}</h4>
              {systemAnnouncementError ? (
                <p className="mt-2 text-12 text-secondary" role="alert">
                  {t("notification.announcement.list_error")}
                </p>
              ) : systemAnnouncementLoader === "loading" ? (
                <p className="mt-2 text-12 text-tertiary">{t("loading")}</p>
              ) : systemAnnouncements.length === 0 ? (
                <p className="mt-2 text-12 text-tertiary">{t("notification.announcement.empty_published")}</p>
              ) : (
                <ul className="mt-2 divide-y divide-subtle">
                  {systemAnnouncements.slice(0, 5).map((announcement) => (
                    <li key={announcement.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-13 text-primary">{announcement.title}</p>
                        <p className="mt-0.5 text-11 text-tertiary">
                          {announcement.published_at && calculateTimeAgo(announcement.published_at)}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-12 font-medium text-primary">
                          {t("notification.announcement.recipients", {
                            count: announcement.recipient_count,
                          })}
                        </p>
                        <p className="text-11 text-tertiary">
                          {t(`notification.announcement.status.${announcement.delivery_status}`)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <div className="flex flex-col-reverse gap-2 border-t border-subtle px-5 py-4 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={isPreview ? () => setIsPreview(false) : closeComposer}>
              {isPreview ? t("notification.announcement.back_to_edit") : t("common.cancel")}
            </Button>
            {isPreview ? (
              <Button variant="primary" disabled={!canPreview} onClick={() => setIsConfirmOpen(true)}>
                {t("notification.announcement.publish")}
              </Button>
            ) : (
              <Button variant="primary" disabled={!canPreview} onClick={() => setIsPreview(true)}>
                {t("notification.announcement.preview")}
              </Button>
            )}
          </div>
        </div>
      </ModalCore>

      <AlertModalCore
        handleClose={() => !isPublishing && setIsConfirmOpen(false)}
        handleSubmit={handlePublish}
        hideIcon
        isSubmitting={isPublishing}
        isOpen={isConfirmOpen}
        title={t("notification.announcement.confirm_title")}
        content={<>{t("notification.announcement.confirm_content")}</>}
        primaryButtonText={{
          default: t("notification.announcement.publish"),
          loading: t("notification.announcement.publishing"),
        }}
        secondaryButtonText={t("common.cancel")}
        variant="primary"
      />
    </>
  );
});
