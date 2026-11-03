import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";

export type TWorkspaceNotificationCategory =
  | "property_change"
  | "state_change"
  | "completion"
  | "assignment"
  | "comment"
  | "mention"
  | "research_property_change"
  | "research_state_change"
  | "research_completion"
  | "research_comment"
  | "research_mention"
  | "system_announcement";

export type TWorkspaceNotificationPolicy = {
  category: TWorkspaceNotificationCategory;
  in_app_enabled: boolean;
  email_enabled: boolean;
};

export type TWorkspaceNotificationPolicyUpdate = {
  category: TWorkspaceNotificationCategory;
  in_app_enabled?: boolean;
  email_enabled?: boolean;
};

export type TWorkspaceNotificationPolicyPage = {
  policies: TWorkspaceNotificationPolicy[];
};

export class WorkspaceNotificationPolicyService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  /** Load the effective workspace notification policy list. */
  async list(workspaceSlug: string): Promise<TWorkspaceNotificationPolicyPage> {
    return this.get(`/api/workspaces/${workspaceSlug}/notification-policies/`).then((response) => response.data);
  }

  /** Update one or more notification channel policies. */
  async update(
    workspaceSlug: string,
    policies: TWorkspaceNotificationPolicyUpdate[]
  ): Promise<TWorkspaceNotificationPolicyPage> {
    return this.patch(`/api/workspaces/${workspaceSlug}/notification-policies/`, { policies }).then(
      (response) => response.data
    );
  }
}
