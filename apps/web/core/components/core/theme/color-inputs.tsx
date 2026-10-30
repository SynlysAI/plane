/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import type { Control } from "react-hook-form";
import { Controller } from "react-hook-form";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { IUserTheme } from "@plane/types";
import { InputColorPicker } from "@plane/ui";
import { isColorDark } from "@plane/utils";

type Props = {
  control: Control<IUserTheme>;
};

/** 补全用户输入的十六进制颜色前缀。 */
function handleValueChange(val: string | undefined, onChange: (...args: unknown[]) => void) {
  let hex = val;
  // prepend a hashtag if it doesn't exist
  if (val && val[0] !== "#") hex = `#${val}`;
  onChange(hex);
}

export const CustomThemeColorInputs = observer(function CustomThemeColorInputs(props: Props) {
  const { control } = props;
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {/* Neutral Color */}
      <div className="flex flex-col gap-2">
        <h3 className="text-body-sm-medium">
          {t("neutral_color")}
          <span className="text-danger-primary">*</span>
        </h3>
        <div className="w-full">
          <Controller
            control={control}
            name="background"
            rules={{
              required: "Neutral color is required",
              pattern: {
                value: /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/,
                message: "Enter a valid hex code",
              },
            }}
            render={({ field: { value, onChange }, fieldState: { error } }) => (
              <>
                <InputColorPicker
                  name="background"
                  value={value}
                  onChange={(val) => handleValueChange(val, onChange)}
                  placeholder="#1a1a1a"
                  className="w-full placeholder:text-placeholder"
                  style={{
                    backgroundColor: value,
                    color: isColorDark(value || "#1a1a1a") ? "#ffffff" : "#252522",
                  }}
                  hasError={Boolean(error)}
                />
                {error && (
                  <p className="text-caption-md-regular text-danger-primary">
                    {t(
                      error.type === "required"
                        ? "background_color_is_required"
                        : "enter_a_valid_hex_code_of_6_characters"
                    )}
                  </p>
                )}
              </>
            )}
          />
        </div>
      </div>
      {/* Brand Color */}
      <div className="flex flex-col gap-2">
        <h3 className="text-body-sm-medium">
          {t("brand_color")}
          <span className="text-danger-primary">*</span>
        </h3>
        <div className="w-full">
          <Controller
            control={control}
            name="primary"
            rules={{
              required: "Brand color is required",
              pattern: {
                value: /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/,
                message: "Enter a valid hex code",
              },
            }}
            render={({ field: { value, onChange }, fieldState: { error } }) => (
              <>
                <InputColorPicker
                  name="primary"
                  value={value}
                  onChange={(val) => handleValueChange(val, onChange)}
                  placeholder="#3f76ff"
                  className="w-full placeholder:text-placeholder"
                  style={{
                    backgroundColor: value,
                    color: isColorDark(value || "#3f76ff") ? "#ffffff" : "#252522",
                  }}
                  hasError={Boolean(error)}
                />
                {error && (
                  <p className="text-caption-md-regular text-danger-primary">
                    {t(
                      error.type === "required" ? "primary_color_is_required" : "enter_a_valid_hex_code_of_6_characters"
                    )}
                  </p>
                )}
              </>
            )}
          />
        </div>
      </div>
    </div>
  );
});
