import { API_BASE_URL } from "@plane/constants";
import type { TResearchIdentity } from "@plane/types";
import { APIService } from "@/services/api.service";

export type TWorkspaceTodo = {
  id: string;
  domain: "RESEARCH" | "ADMINISTRATIVE";
  source: string;
  object_id: string;
  title: string;
  context: string;
  requester: { id: string; display_name: string } | null;
  project_id?: string;
  business_status: string;
  handling_status: string;
  due_at: string | null;
  urgency: string;
  updated_at: string;
  href: string;
};
export type TWorkspaceTodoPage = {
  results: TWorkspaceTodo[];
  total_count: number;
  next_cursor: string | null;
  degraded_sources: string[];
};
export type TAdministrativeApproval = {
  id: string;
  project_id: string;
  project_name: string;
  issue_id: string;
  title: string;
  status: string;
  step: number;
  flow_id: string;
  flow_name: string;
  flow_version: number;
  approval_mode: "FLOW" | "DIRECT";
  requester: { id: string; display_name: string };
  approvers: { id: string; display_name: string }[];
  can_act: boolean;
  can_withdraw: boolean;
  can_cancel: boolean;
  blocked: boolean;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  work_item?: {
    id: string;
    workspace_id: string;
    identifier: string;
    name: string;
    description_html: string;
    state: string | null;
    priority: string;
    start_date: string | null;
    target_date: string | null;
    assignees: { id: string; display_name: string }[];
    attachments: { id: string; name: string; url: string }[];
  };
  steps?: { order: number; approver_kind: string; approver_name: string }[];
  history?: { id: string; action: string; actor: string; comment: string; step: number; created_at: string }[];
};
export function domainError(error: unknown): string {
  const response = (error as { response?: { data?: unknown } })?.response?.data;
  if (typeof response === "string") return response;
  if (Array.isArray(response)) return response.join("；");
  if (response && typeof response === "object") {
    const data = response as { message?: string; detail?: string };
    return data.message ?? data.detail ?? "操作失败，请检查输入后重试。";
  }
  return "请求失败，请稍后重试。";
}

export class ProjectDomainsService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }
  async setResearchEnabled(slug: string, enabled: boolean): Promise<TResearchIdentity> {
    return this.patch(`/api/workspaces/${slug}/context/`, { research_enabled: enabled }).then((res) => res.data);
  }
  async todos(slug: string, domain = "all", cursor?: string): Promise<TWorkspaceTodoPage> {
    return this.get(`/api/workspaces/${slug}/todos/`, { params: { domain, cursor, limit: 50 } }).then(
      (res) => res.data
    );
  }
  async requests(
    slug: string,
    scope = "to_me",
    projectId?: string,
    status?: string
  ): Promise<TAdministrativeApproval[]> {
    return this.get(`/api/workspaces/${slug}/administrative/approval-requests/`, {
      params: { scope, project_id: projectId, status },
    }).then((res) => res.data.results);
  }
  async getRequest(slug: string, id: string, projectId?: string): Promise<TAdministrativeApproval> {
    return this.get(`/api/workspaces/${slug}/administrative/approval-requests/${id}/`, {
      params: { project_id: projectId },
    }).then((res) => res.data);
  }
  async act(
    slug: string,
    item: TAdministrativeApproval,
    action: string,
    comment: string
  ): Promise<TAdministrativeApproval> {
    return this.post(`/api/workspaces/${slug}/administrative/approval-requests/${item.id}/`, {
      action,
      expected_step: item.step,
      comment,
    }).then((res) => res.data);
  }
}
