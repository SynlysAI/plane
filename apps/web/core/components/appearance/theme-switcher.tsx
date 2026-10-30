/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useMemo } from "react";
import { observer } from "mobx-react";
import { useTheme } from "next-themes";
// plane imports
import type { I_THEME_OPTION } from "@plane/constants";
import { THEME_OPTIONS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { setPromiseToast } from "@plane/propel/toast";
import { applyCustomTheme, clearCustomTheme } from "@plane/utils";
import type { IUserTheme } from "@plane/types";
// components
import { CustomThemeSelector } from "@/components/core/theme/custom-theme-selector";
import { ThemeSwitch } from "@/components/core/theme/theme-switch";
import { SettingsControlItem } from "@/components/settings/control-item";
// hooks
import { useUserProfile } from "@/hooks/store/user";

export const ThemeSwitcher = observer(function ThemeSwitcher(props: {
  option: {
    id: string;
    title: string;
    description: string;
  };
}) {
  // store hooks
  const { data: userProfile, updateUserTheme } = useUserProfile();
  // theme
  const { resolvedTheme, setTheme } = useTheme();
  // translation
  const { t } = useTranslation();
  // derived values
  const currentTheme = useMemo(() => {
    // oxlint-disable-next-line no-shadow
    const userThemeOption = THEME_OPTIONS.find((t) => t.value === userProfile?.theme?.theme);
    return userThemeOption || null;
  }, [userProfile?.theme?.theme]);

  /** 构造首次选择自定义主题时的完整可保存配置。 */
  const buildCustomThemePayload = useCallback((): Partial<IUserTheme> => {
    const theme = userProfile?.theme;
    const darkPalette =
      theme?.theme === "custom" && typeof theme.darkPalette === "boolean"
        ? theme.darkPalette
        : (resolvedTheme?.includes("dark") ?? false);

    return {
      theme: "custom",
      primary: theme?.primary || "#3f76ff",
      background: theme?.background || (darkPalette ? "#1a1a1a" : "#f7f7f5"),
      darkPalette,
    };
  }, [resolvedTheme, userProfile?.theme]);

  const handleThemeChange = useCallback(
    async (themeOption: I_THEME_OPTION) => {
      const payload = themeOption.value === "custom" ? buildCustomThemePayload() : { theme: themeOption.value };
      const updatePromise = updateUserTheme(payload);
      try {
        setPromiseToast(updatePromise, {
          loading: "Updating theme...",
          success: {
            title: "Theme updated",
            message: () => "Theme updated in place.",
          },
          error: {
            title: "Error!",
            message: () => "Failed to update theme. Please try again.",
          },
        });
        await updatePromise;
        setTheme(themeOption.value);

        if (themeOption.value === "custom" && payload.primary && payload.background) {
          applyCustomTheme(payload.primary, payload.background, payload.darkPalette ? "dark" : "light");
        } else {
          clearCustomTheme();
        }
      } catch (error) {
        console.error("Error updating theme:", error);
      }
    },
    [buildCustomThemePayload, setTheme, updateUserTheme]
  );

  if (!userProfile) return null;

  return (
    <>
      <SettingsControlItem
        title={t(props.option.title)}
        description={t(props.option.description)}
        control={
          <ThemeSwitch
            value={currentTheme}
            onChange={(themeOption) => {
              void handleThemeChange(themeOption);
            }}
          />
        }
      />
      {userProfile.theme?.theme === "custom" && <CustomThemeSelector />}
    </>
  );
});
