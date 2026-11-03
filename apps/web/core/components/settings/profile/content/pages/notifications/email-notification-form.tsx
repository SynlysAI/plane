/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef } from "react";
import { observer } from "mobx-react";
import { Controller, useForm } from "react-hook-form";
// plane imports
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { IUserEmailNotificationSettings } from "@plane/types";
import { Switch } from "@makeplane/propel/components/switch";
// components
import { SettingsControlItem } from "@/components/settings/control-item";
// services
import { UserService } from "@/services/user.service";

type Props = {
  data: IUserEmailNotificationSettings;
};

// services
const userService = new UserService();

export const NotificationsProfileSettingsForm = observer(function NotificationsProfileSettingsForm(props: Props) {
  const { data } = props;
  // translation
  const { t } = useTranslation();
  // form data
  const { control, reset, setValue } = useForm<IUserEmailNotificationSettings>({
    defaultValues: {
      ...data,
    },
  });
  const persistedValues = useRef<IUserEmailNotificationSettings>(data);
  const updateQueues = useRef(new Map<keyof IUserEmailNotificationSettings, Promise<void>>());
  const updateVersions = useRef(new Map<keyof IUserEmailNotificationSettings, number>());

  const handleSettingChange = async (key: keyof IUserEmailNotificationSettings, value: boolean) => {
    const version = (updateVersions.current.get(key) ?? 0) + 1;
    updateVersions.current.set(key, version);
    const previousUpdate = updateQueues.current.get(key) ?? Promise.resolve();
    const update = previousUpdate
      .catch(() => undefined)
      .then(() => userService.updateCurrentUserEmailNotificationSettings({ [key]: value }))
      .then(() => {
        persistedValues.current = { ...persistedValues.current, [key]: value };
        return undefined;
      });
    updateQueues.current.set(key, update);
    try {
      await update;
      setToast({
        title: t("success"),
        type: TOAST_TYPE.SUCCESS,
        message: t("email_notification_setting_updated_successfully"),
      });
    } catch (_error) {
      if (updateVersions.current.get(key) === version) {
        setValue(key, persistedValues.current[key]);
      }
      setToast({
        title: t("error"),
        type: TOAST_TYPE.ERROR,
        message: t("failed_to_update_email_notification_setting"),
      });
    }
  };

  useEffect(() => {
    reset(data);
    persistedValues.current = data;
  }, [reset, data]);

  return (
    <div className="flex flex-col gap-y-1">
      <SettingsControlItem
        title={t("assignment")}
        description={t("assignment_notification_description")}
        control={
          <Controller
            control={control}
            name="assignment"
            render={({ field: { value, onChange } }) => (
              <Switch
                size="sm"
                checked={value}
                onCheckedChange={(newValue) => {
                  onChange(newValue);
                  void handleSettingChange("assignment", newValue);
                }}
                aria-label={t("assignment")}
              />
            )}
          />
        }
      />
      <SettingsControlItem
        title={t("property_changes")}
        description={t("property_changes_description")}
        control={
          <Controller
            control={control}
            name="property_change"
            render={({ field: { value, onChange } }) => (
              <Switch
                size="sm"
                checked={value}
                onCheckedChange={(newValue) => {
                  onChange(newValue);
                  void handleSettingChange("property_change", newValue);
                }}
                aria-label={t("property_changes")}
              />
            )}
          />
        }
      />
      <SettingsControlItem
        title={t("state_change")}
        description={t("state_change_description")}
        control={
          <Controller
            control={control}
            name="state_change"
            render={({ field: { value, onChange } }) => (
              <Switch
                size="sm"
                checked={value}
                onCheckedChange={(newValue) => {
                  onChange(newValue);
                  void handleSettingChange("state_change", newValue);
                }}
                aria-label={t("state_change")}
              />
            )}
          />
        }
      />
      <div className="border-l-3 border-subtle-1 pl-3">
        <SettingsControlItem
          title={t("issue_completed")}
          description={t("issue_completed_description")}
          control={
            <Controller
              control={control}
              name="issue_completed"
              render={({ field: { value, onChange } }) => (
                <Switch
                  size="sm"
                  checked={value}
                  onCheckedChange={(newValue) => {
                    onChange(newValue);
                    void handleSettingChange("issue_completed", newValue);
                  }}
                  aria-label={t("issue_completed")}
                />
              )}
            />
          }
        />
      </div>
      <SettingsControlItem
        title={t("comments")}
        description={t("comments_description")}
        control={
          <Controller
            control={control}
            name="comment"
            render={({ field: { value, onChange } }) => (
              <Switch
                size="sm"
                checked={value}
                onCheckedChange={(newValue) => {
                  onChange(newValue);
                  void handleSettingChange("comment", newValue);
                }}
                aria-label={t("comments")}
              />
            )}
          />
        }
      />
      <SettingsControlItem
        title={t("mentions")}
        description={t("mentions_description")}
        control={
          <Controller
            control={control}
            name="mention"
            render={({ field: { value, onChange } }) => (
              <Switch
                size="sm"
                checked={value}
                onCheckedChange={(newValue) => {
                  onChange(newValue);
                  void handleSettingChange("mention", newValue);
                }}
                aria-label={t("mentions")}
              />
            )}
          />
        }
      />
      <h3 className="text-sm pt-4 font-medium text-primary">{t("research_notifications")}</h3>
      {(
        [
          ["research_property_change", "research_property_changes", "research_property_changes_description"],
          ["research_state_change", "research_state_changes", "research_state_changes_description"],
          ["research_comment", "research_comments", "research_comments_description"],
          ["research_mention", "research_mentions", "research_mentions_description"],
          ["research_completion", "research_completion", "research_completion_description"],
        ] as const
      ).map(([key, label, description]) => (
        <SettingsControlItem
          key={key}
          title={t(label)}
          description={t(description)}
          control={
            <Controller
              control={control}
              name={key}
              render={({ field: { value, onChange } }) => (
                <Switch
                  size="sm"
                  checked={value}
                  onCheckedChange={(newValue) => {
                    onChange(newValue);
                    void handleSettingChange(key, newValue);
                  }}
                  aria-label={t(label)}
                />
              )}
            />
          }
        />
      ))}
    </div>
  );
});
