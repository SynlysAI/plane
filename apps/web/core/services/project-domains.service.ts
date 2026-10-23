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
}
