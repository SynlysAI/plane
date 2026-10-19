import { API_BASE_URL } from "@plane/constants";
import type { TResearchIdentity } from "@plane/types";
import { APIService } from "@/services/api.service";

export type TWorkspaceTodo = {
  id: string; domain: "RESEARCH" | "ADMINISTRATIVE"; source: string; object_id: string;
  title: string; context: string; project_id?: string; business_status: string;
  handling_status: string; due_at: string | null; urgency: string; updated_at: string; href: string;
};
export type TWorkspaceTodoPage = {
  results: TWorkspaceTodo[]; total_count: number; next_cursor: string | null; degraded_sources: string[];
};
export type TAdministrativeApprovalStep = { order: number; approver_kind: "ORG_ADMIN" | "USER"; approver_id: string | null };
export type TAdministrativeFlow = { id: string; organization_id: string; name: string; version: number; is_active: boolean; steps: TAdministrativeApprovalStep[] };
export type TAdministrativeApproval = {
  id: string; project_id: string; project_name: string; issue_id: string; title: string;
  status: string; step: number; flow_id: string; flow_name: string; flow_version: number;
  requester: { id: string; display_name: string }; approvers: { id: string; display_name: string }[];
  can_act: boolean; can_withdraw: boolean; can_cancel: boolean; blocked: boolean;
  due_at: string | null; created_at: string; updated_at: string;
  history?: { id: string; action: string; actor: string; comment: string; step: number; created_at: string }[];
};
export type TProjectApprovalSetting = { flow_id: string | null; organization_id: string | null; can_manage: boolean; can_submit: boolean };

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
  constructor() { super(API_BASE_URL); }
  async setResearchEnabled(slug: string, enabled: boolean): Promise<TResearchIdentity> {
    return this.patch(`/api/workspaces/${slug}/context/`, { research_enabled: enabled }).then((res) => res.data);
  }
  async todos(slug: string, domain = "all", cursor?: string): Promise<TWorkspaceTodoPage> {
    return this.get(`/api/workspaces/${slug}/todos/`, { params: { domain, cursor, limit: 50 } }).then((res) => res.data);
  }
  async flows(slug: string, organizationId?: string): Promise<TAdministrativeFlow[]> {
    return this.get(`/api/workspaces/${slug}/administrative/approval-flows/`, { params: { organization_id: organizationId } }).then((res) => res.data.results);
  }
  async approvers(slug: string, organizationId: string): Promise<{ id: string; name: string; email: string }[]> {
    return this.get(`/api/workspaces/${slug}/administrative/organizations/${organizationId}/approvers/`).then((res) => res.data);
  }
  async saveFlow(slug: string, payload: Pick<TAdministrativeFlow, "organization_id" | "name" | "steps">, id?: string): Promise<TAdministrativeFlow> {
    const path = `/api/workspaces/${slug}/administrative/approval-flows/${id ? `${id}/` : ""}`;
    return (id ? this.patch(path, payload) : this.post(path, payload)).then((res) => res.data);
  }
  async projectSetting(slug: string, projectId: string): Promise<TProjectApprovalSetting> {
    return this.get(`/api/workspaces/${slug}/projects/${projectId}/approval-setting/`).then((res) => res.data);
  }
  async selectFlow(slug: string, projectId: string, flowId: string): Promise<TProjectApprovalSetting> {
    return this.patch(`/api/workspaces/${slug}/projects/${projectId}/approval-setting/`, { flow_id: flowId }).then((res) => res.data);
  }
  async requests(slug: string, scope = "to_me", projectId?: string): Promise<TAdministrativeApproval[]> {
    return this.get(`/api/workspaces/${slug}/administrative/approval-requests/`, { params: { scope, project_id: projectId } }).then((res) => res.data.results);
  }
  async getRequest(slug: string, id: string): Promise<TAdministrativeApproval> {
    return this.get(`/api/workspaces/${slug}/administrative/approval-requests/${id}/`).then((res) => res.data);
  }
  async submit(slug: string, projectId: string, issueId: string): Promise<TAdministrativeApproval> {
    return this.post(`/api/workspaces/${slug}/administrative/approval-requests/`, { project_id: projectId, issue_id: issueId }).then((res) => res.data);
  }
  async act(slug: string, item: TAdministrativeApproval, action: string, comment: string): Promise<TAdministrativeApproval> {
    return this.post(`/api/workspaces/${slug}/administrative/approval-requests/${item.id}/`, { action, expected_step: item.step, comment }).then((res) => res.data);
  }
}
