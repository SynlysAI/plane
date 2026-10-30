/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useMemo } from "react";
import { observer } from "mobx-react";
import { useForm } from "react-hook-form";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { IUserTheme } from "@plane/types";
// components
import { ProfileSettingsHeading } from "@/components/settings/profile/heading";
// hooks
import { useUserProfile } from "@/hooks/store/user";
// local imports
import { CustomThemeColorInputs } from "./color-inputs";
import { CustomThemeDownloadConfigButton } from "./download-config-button";
import { CustomThemeImportConfigButton } from "./import-config-button";
import { CustomThemeModeSelector } from "./theme-mode-selector";

export const CustomThemeSelector = observer(function CustomThemeSelector() {
  // store hooks
  const { data: userProfile, updateUserTheme } = useUserProfile();
  // translation
  const { t } = useTranslation();

  // 只订阅配色字段，避免保存背景偏好时清空尚未提交的配色草稿。
  const { primary, background, darkPalette: savedDarkPalette } = userProfile?.theme ?? {};
  const savedTheme = useMemo((): IUserTheme => {
    const darkPalette = savedDarkPalette ?? false;

    return {
      theme: "custom",
      primary: primary || "#3f76ff",
      background: background || (darkPalette ? "#1a1a1a" : "#f7f7f5"),
      darkPalette,
    };
  }, [primary, background, savedDarkPalette]);

  const {
    control,
    formState: { isSubmitting },
    reset,
    handleSubmit,
    getValues,
    setValue,
  } = useForm<IUserTheme>({
    defaultValues: savedTheme,
  });

  useEffect(() => {
    reset(savedTheme);
  }, [reset, savedTheme]);

  const handleUpdateTheme = async (formData: IUserTheme) => {
    if (!formData.primary || !formData.background) return;

    try {
      await updateUserTheme({
        theme: "custom",
        primary: formData.primary,
        background: formData.background,
        darkPalette: formData.darkPalette,
      });

      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("success"),
        message: t("theme_updated_successfully"),
      });
    } catch (error) {
      console.error("Failed to apply theme:", error);
      setToast({
        type: TOAST_TYPE.ERROR,
        title: t("error"),
        message: t("failed_to_update_the_theme"),
      });
    }
  };

  return (
    <form
      onSubmit={(e) => {
        void handleSubmit(handleUpdateTheme)(e);
      }}
      className="workspace-content-inset rounded-lg border border-subtle bg-layer-1 px-4 py-3"
    >
      <div className="space-y-5">
        <ProfileSettingsHeading
          title={t("customize_your_theme")}
          control={<CustomThemeImportConfigButton handleUpdateTheme={handleUpdateTheme} setValue={setValue} />}
        />
        <CustomThemeModeSelector control={control} />
        {/* Color Inputs */}
        <CustomThemeColorInputs control={control} />
      </div>
      <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        {/* Save Theme Button */}
        <Button variant="primary" size="lg" type="submit" loading={isSubmitting}>
          {isSubmitting ? t("common.saving") : t("set_theme")}
        </Button>
        {/* Import/Export Section */}
        <CustomThemeDownloadConfigButton getValues={getValues} />
      </div>
    </form>
  );
});
