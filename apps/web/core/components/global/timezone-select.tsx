/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { DEFAULT_TIMEZONE } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { CustomSearchSelect } from "@plane/ui";
import { cn } from "@plane/utils";
// hooks
import useTimezone from "@/hooks/use-timezone";

type TTimezoneSelect = {
  value: string | undefined;
  onChange: (value: string) => void;
  error?: boolean;
  label?: string;
  buttonClassName?: string;
  className?: string;
  optionsClassName?: string;
  disabled?: boolean;
};

export const TimezoneSelect = observer(function TimezoneSelect(props: TTimezoneSelect) {
  const { t } = useTranslation();
  // props
  const {
    value,
    onChange,
    error = false,
    label = t("project_settings.general.please_select_a_timezone"),
    buttonClassName = "",
    className = "",
    optionsClassName = "",
    disabled = false,
  } = props;
  // hooks
  const { disabled: isDisabled, timezones, selectedValue } = useTimezone();
  const selectedValueOrDefault = value || DEFAULT_TIMEZONE;

  return (
    <div>
      <CustomSearchSelect
        value={selectedValueOrDefault}
        label={selectedValue ? selectedValue(selectedValueOrDefault) : label}
        options={isDisabled || disabled ? [] : timezones}
        onChange={onChange}
        buttonClassName={cn(buttonClassName, "border border-subtle-1", {
          "border-danger-strong": error,
        })}
        className={cn("rounded-md", className)}
        optionsClassName={cn("w-72", optionsClassName)}
        input
        disabled={isDisabled || disabled}
        placement="bottom-end"
      />
    </div>
  );
});
