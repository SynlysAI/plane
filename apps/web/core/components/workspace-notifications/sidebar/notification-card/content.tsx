/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TNotification } from "@plane/types";
import {
  convertMinutesToHoursMinutesString,
  renderFormattedDate,
  sanitizeCommentForNotification,
  stripAndTruncateHTML,
} from "@plane/utils";
// components
import { LiteTextEditor } from "@/components/editor/lite-text";
import {
  ADDITIONAL_NOTIFICATION_CONTENT_MAP,
  renderAdditionalAction,
  renderAdditionalValue,
  shouldShowConnector,
} from "../../notification-card/content";

// Types
export type TNotificationFieldData = {
  field: string | undefined;
  newValue: string | undefined;
  oldValue: string | undefined;
  verb: string | undefined;
};

export type TNotificationContentDetails = {
  action?: ReactNode;
  value?: ReactNode;
  showConnector?: boolean;
};

export type TNotificationContentHandler = (data: TNotificationFieldData) => TNotificationContentDetails | null;

export type TNotificationContentMap = {
  [key: string]: TNotificationContentHandler;
};

// Base notification content map for core fields
export const BASE_NOTIFICATION_CONTENT_MAP: TNotificationContentMap = {
  duplicate: ({ verb }) => ({
    action:
      verb === "created"
        ? "notification_content.actions.marked_duplicate"
        : "notification_content.actions.marked_not_duplicate",
    value: null,
    showConnector: false,
  }),
  assignees: ({ newValue, oldValue }) => ({
    action:
      newValue !== "" ? "notification_content.actions.added_assignee" : "notification_content.actions.removed_assignee",
    value: newValue !== "" ? newValue : oldValue,
    showConnector: false,
  }),
  start_date: ({ newValue }) => ({
    action:
      newValue !== ""
        ? "notification_content.actions.set_start_date"
        : "notification_content.actions.removed_start_date",
    value: renderFormattedDate(newValue),
    showConnector: false,
  }),
  target_date: ({ newValue }) => ({
    action:
      newValue !== "" ? "notification_content.actions.set_due_date" : "notification_content.actions.removed_due_date",
    value: renderFormattedDate(newValue),
    showConnector: false,
  }),
  name: ({ newValue }) => ({
    action: "notification_content.actions.updated_name",
    value: newValue,
    showConnector: true,
  }),
  state: ({ newValue }) => ({
    action: "notification_content.actions.updated_state",
    value: newValue,
    showConnector: true,
  }),
  labels: ({ newValue, oldValue }) => ({
    action: newValue !== "" ? "notification_content.actions.added_label" : "notification_content.actions.removed_label",
    value: newValue !== "" ? newValue : oldValue,
    showConnector: false,
  }),
  parent: ({ newValue, oldValue }) => ({
    action: newValue !== "" ? "added parent" : "removed parent",
    value: newValue !== "" ? newValue : oldValue,
    showConnector: false,
  }),
  relates_to: () => ({
    action: "notification_content.actions.related_to",
    value: null,
    showConnector: true,
  }),
  comment: ({ newValue }, renderCommentBox?: boolean) => ({
    action: "notification_content.actions.commented",
    value: renderCommentBox ? null : sanitizeCommentForNotification(newValue),
    showConnector: false,
  }),
  archived_at: ({ newValue }) => ({
    action:
      newValue === "restore"
        ? "notification_content.actions.restored_work_item"
        : "notification_content.actions.archived_work_item",
    value: null,
    showConnector: false,
  }),
  None: () => ({
    action: null,
    value: "the work item and assigned it to you.",
    showConnector: false,
  }),
  // Fields below only define value - action falls through to default handler
  attachment: () => ({
    action: null,
    value: "the work item",
    showConnector: true,
  }),
  description: ({ newValue }) => ({
    value: stripAndTruncateHTML(newValue || "", 55),
    showConnector: true,
  }),
  estimate_time: ({ newValue, oldValue }) => ({
    value:
      newValue !== ""
        ? convertMinutesToHoursMinutesString(Number(newValue))
        : convertMinutesToHoursMinutesString(Number(oldValue)),
    showConnector: true,
  }),
};

// Helper to get content details from maps
const getNotificationContentDetails = (
  fieldData: TNotificationFieldData,
  renderCommentBox?: boolean
): TNotificationContentDetails | null => {
  const { field } = fieldData;
  if (!field) return null;

  // Check base map first
  const baseHandler = BASE_NOTIFICATION_CONTENT_MAP[field];
  if (baseHandler) {
    // Special case for comment field that needs renderCommentBox
    if (field === "comment") {
      return (baseHandler as (data: TNotificationFieldData, renderCommentBox?: boolean) => TNotificationContentDetails)(
        fieldData,
        renderCommentBox
      );
    }
    return baseHandler(fieldData);
  }

  // Check additional map from plane-web (EE extensions)
  const additionalHandler = ADDITIONAL_NOTIFICATION_CONTENT_MAP[field];
  if (additionalHandler) {
    return additionalHandler(fieldData);
  }

  return null;
};

export function NotificationContent({
  notification,
  workspaceId,
  workspaceSlug,
  projectId,
  renderCommentBox = false,
}: {
  notification: TNotification;
  workspaceId: string;
  workspaceSlug: string;
  projectId: string;
  renderCommentBox?: boolean;
}) {
  const { t } = useTranslation();
  const { data, triggered_by_details: triggeredBy } = notification;
  const notificationField = data?.issue_activity.field;
  const newValue = data?.issue_activity.new_value;
  const oldValue = data?.issue_activity.old_value;
  const verb = data?.issue_activity.verb;

  const fieldData: TNotificationFieldData = {
    field: notificationField,
    newValue,
    oldValue,
    verb,
  };

  const renderTriggerName = () => (
    <span className="font-medium text-primary">
      {triggeredBy?.is_bot ? triggeredBy.first_name : triggeredBy?.display_name}{" "}
    </span>
  );

  // Get content details from map
  const contentDetails = getNotificationContentDetails(fieldData, renderCommentBox);

  // Render action - use map value if defined, otherwise fall through to default handler
  // Note: undefined = fall through to default, null = explicitly no action text
  const renderAction = (): ReactNode => {
    if (!notificationField) return "";
    // Check if action is explicitly defined in map (including null)
    if (contentDetails && "action" in contentDetails) {
      return typeof contentDetails.action === "string" ? t(contentDetails.action) : contentDetails.action;
    }
    // Fallback to default action handler for fields not in map or without action defined
    return renderAdditionalAction(notificationField, verb);
  };

  // Render value - use map value if defined, otherwise fall through to default handler
  const renderValue = (): ReactNode => {
    // Check if value is explicitly defined in map
    if (contentDetails && "value" in contentDetails) return contentDetails.value;
    // Fallback to default value handler for fields not in map or without value defined
    return renderAdditionalValue(notificationField, newValue, oldValue);
  };

  // Determine if connector should be shown - prefer map value, fallback to function
  const showConnector =
    contentDetails?.showConnector !== undefined ? contentDetails.showConnector : shouldShowConnector(notificationField);

  return (
    <>
      {renderTriggerName()}
      <span className="text-tertiary">{renderAction()} </span>
      {verb !== "deleted" && (
        <>
          {showConnector && <span className="text-tertiary">{t("notification_content.connector_to")} </span>}
          <span className="font-medium text-primary">{renderValue()}</span>
          {notificationField === "comment" && renderCommentBox && (
            <div className="origin-left scale-75">
              <LiteTextEditor
                editable={false}
                id=""
                initialValue={newValue ?? ""}
                workspaceId={workspaceId}
                workspaceSlug={workspaceSlug}
                projectId={projectId}
                displayConfig={{
                  fontSize: "small-font",
                }}
              />
            </div>
          )}
          {"."}
        </>
      )}
    </>
  );
}
