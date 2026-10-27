/** Shared notification-member contract for research tasks and administrative work items. */

export type TTaskNotificationRecipientGroup = {
  id: string;
  name: string;
};

export type TTaskNotificationRecipientCandidate = {
  id: string;
  display_name: string;
  email: string;
  avatar_url: string | null;
  group_ids: string[];
};

export type TTaskNotificationRecipients = {
  schema_version: "task-notification-recipients.v1";
  groups: TTaskNotificationRecipientGroup[];
  candidates: TTaskNotificationRecipientCandidate[];
  selected_user_ids: string[];
  cc_user_ids: string[];
  fixed_user_ids: string[];
  recipient_user_ids: string[];
  current_user_subscribed: boolean;
  current_user_self_subscribed: boolean;
  can_manage: boolean;
};
