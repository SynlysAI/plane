/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useRef, useState } from "react";
import { useSWRConfig } from "swr";
// types
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { APITokenService } from "@plane/services";
import { tokenErrorKey } from "./error";
// ui
import { AlertModalCore } from "@plane/ui";
// fetch-keys
import { API_TOKENS_LIST } from "@plane/constants";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  tokenId: string;
};

const apiTokenService = new APITokenService();

export function DeleteApiTokenModal(props: Props) {
  const { mutate } = useSWRConfig();
  const { isOpen, onClose, tokenId } = props;
  // states
  const [deleteLoading, setDeleteLoading] = useState<boolean>(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  // router params
  const { t } = useTranslation();

  const handleClose = () => {
    if (pending.current) return;
    setError("");
    onClose();
  };

  const handleDeletion = async () => {
    if (pending.current) return;
    pending.current = true;
    setDeleteLoading(true);
    setError("");

    await apiTokenService
      .destroy(tokenId)
      .then(() => {
        setToast({
          type: TOAST_TYPE.SUCCESS,
          title: t("workspace_settings.settings.api_tokens.delete.success.title"),
          message: t("workspace_settings.settings.api_tokens.delete.success.message"),
        });

        void mutate(
          API_TOKENS_LIST,
          (prevData: import("@plane/types").IApiToken[] | undefined) =>
            (prevData ?? []).filter((token) => token.id !== tokenId),
          { revalidate: true }
        ).catch(() => {
          /* The list displays its own refresh error and retry control. */
        });
        pending.current = false;
        handleClose();
        setDeleteLoading(false);
        return undefined;
      })
      .catch((err) => {
        const message =
          err?.detail ||
          err?.error ||
          t(err?.status === 401 || err?.status === 403 ? tokenErrorKey(err) : "api_token_management.delete_error");
        setError(message);
        setToast({
          type: TOAST_TYPE.ERROR,
          title: t("workspace_settings.settings.api_tokens.delete.error.title"),
          message,
        });
        pending.current = false;
        setDeleteLoading(false);
      });
  };

  return (
    <AlertModalCore
      handleClose={handleClose}
      handleSubmit={handleDeletion}
      isSubmitting={deleteLoading}
      isOpen={isOpen}
      title={t("workspace_settings.settings.api_tokens.delete.title")}
      content={
        <>
          {t("workspace_settings.settings.api_tokens.delete.description")}
          {error && (
            <p role="alert" className="mt-2 text-danger-primary">
              {error}
            </p>
          )}
        </>
      }
    />
  );
}
