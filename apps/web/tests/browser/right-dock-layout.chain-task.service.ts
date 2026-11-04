/** Isolated chain-task service for the right-dock browser fixture. */
export class ResearchChainTaskService {
  getNodeEvents = async () => [];

  getTaskComments = async () => ({ results: [], count: 0 });

  getTaskCommentAttachmentLimits = async () => ({
    image: { max_mb: 20, max_bytes: 20 * 1024 * 1024 },
    pdf: { max_mb: 100, max_bytes: 100 * 1024 * 1024 },
    markdown: { max_mb: 5, max_bytes: 5 * 1024 * 1024 },
    office: { max_mb: 50, max_bytes: 50 * 1024 * 1024 },
  });

  getNotificationRecipients = async () => ({
    schema_version: "task-notification-recipients.v1",
    groups: [],
    candidates: [],
    selected_user_ids: [],
    cc_user_ids: [],
    fixed_user_ids: [],
    recipient_user_ids: [],
    current_user_subscribed: false,
    current_user_self_subscribed: false,
    can_manage: false,
  });
}
