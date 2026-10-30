/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useRef, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { MAX_FILE_SIZE } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EFileAssetType } from "@plane/types";
import { getAssetIdFromUrl, getFileURL } from "@plane/utils";
// helpers
import { WORKSPACE_BACKGROUND_IMAGES } from "@/helpers/workspace-backgrounds";
// hooks
import { useUserProfile } from "@/hooks/store/user";
// services
import { FileService } from "@/services/file.service";

const fileService = new FileService();
const ACCEPTED_BACKGROUND_MIME_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

/** 判断背景来源是否为本系统上传资产。 */
function isUploadedBackground(source: string | null | undefined): source is string {
  return Boolean(source?.includes("/api/assets/v2/static/"));
}

export const WorkspaceBackgroundSettings = observer(function WorkspaceBackgroundSettings() {
  const { data: userProfile, updateUserTheme } = useUserProfile();
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isSaving, setIsSaving] = useState(false);
  const currentBackground = userProfile?.theme?.backgroundImage ?? null;

  /** 保存成功后尽力清理不再引用的旧上传资产。 */
  const removePreviousUploadedBackground = async (source: string | null | undefined) => {
    if (!isUploadedBackground(source)) return;
    const assetId = getAssetIdFromUrl(source);
    try {
      await fileService.deleteUserAsset(assetId);
    } catch (error) {
      console.warn("Failed to remove the previous workspace background:", error);
    }
  };

  /** 保存背景偏好并返回是否成功。 */
  const saveBackground = async (source: string | null) => {
    setIsSaving(true);
    try {
      await updateUserTheme({ backgroundImage: source });
      await removePreviousUploadedBackground(currentBackground);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("success"),
        message: t("workspace_background_updated_successfully"),
      });
      return true;
    } catch (error) {
      console.error("Failed to update workspace background:", error);
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("error"),
        message: t("failed_to_update_workspace_background"),
      });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  /** 校验并上传用户选择的背景图。 */
  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("error"),
        message: t("workspace_background_file_too_large"),
      });
      return;
    }
    if (!ACCEPTED_BACKGROUND_MIME_TYPES.has(file.type)) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("error"),
        message: t("workspace_background_invalid_type"),
      });
      return;
    }

    setIsSaving(true);
    try {
      const asset = await fileService.uploadUserAsset(
        {
          entity_identifier: "",
          entity_type: EFileAssetType.USER_BACKGROUND,
        },
        file
      );
      const saved = await saveBackground(asset.asset_url);
      if (!saved) await fileService.deleteUserAsset(asset.asset_id).catch(() => undefined);
    } catch (error) {
      console.error("Failed to upload workspace background:", error);
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("error"),
        message: t("failed_to_update_workspace_background"),
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="rounded-lg border border-subtle bg-layer-1 px-4 py-3" aria-label={t("workspace_background")}>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-1">
          <h4 className="text-body-sm-medium text-primary">{t("workspace_background")}</h4>
          <p className="text-caption-md-regular text-secondary">{t("workspace_background_description")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isSaving}
            loading={isSaving}
          >
            {isSaving ? t("workspace_background_uploading") : t("workspace_background_upload")}
          </Button>
          {currentBackground && (
            <Button
              variant="secondary"
              size="sm"
              data-testid="remove-background"
              onClick={() => void saveBackground(null)}
              disabled={isSaving}
            >
              {t("workspace_background_remove")}
            </Button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/jpg,image/png,image/webp"
            className="hidden"
            onChange={(event) => void handleUpload(event)}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="h-20 w-full shrink-0 overflow-hidden rounded-md border border-subtle sm:w-32">
          {currentBackground ? (
            <img
              src={getFileURL(currentBackground)}
              alt={t("workspace_background_current")}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="grid h-full w-full place-items-center bg-layer-2 text-caption-md-regular text-tertiary">
              {t("workspace_background_empty")}
            </div>
          )}
        </div>
        <div className="grid w-full grid-cols-3 gap-2 sm:grid-cols-6">
          {WORKSPACE_BACKGROUND_IMAGES.map((image, index) => {
            const isSelected = currentBackground === image;
            return (
              <button
                key={image}
                type="button"
                data-testid={`background-option-${index}`}
                aria-pressed={isSelected}
                disabled={isSaving}
                onClick={() => void saveBackground(image)}
                className={`overflow-hidden rounded-md border transition-colors ${
                  isSelected ? "border-accent-strong" : "border-subtle hover:border-strong"
                }`}
              >
                <img src={image} alt={t("workspace_background_builtin")} className="h-12 w-full object-cover" />
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
});
