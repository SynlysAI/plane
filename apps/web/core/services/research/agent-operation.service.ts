import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";

export type TAgentAction =
  | "create_task"
  | "append_task_comment"
  | "save_analysis_draft"
  | "attach_task_resource"
  | "append_research_note";
export type TAgentOperation = {
  operation_id: string;
  node_id: string;
  chain_id: string;
  action: TAgentAction;
  payload: Record<string, string | number>;
  target?: { project_name?: string; node_title?: string; task_title?: string; task_id?: string };
  source_refs: { kind: string; id: string; version?: number; usage: "body" | "metadata" }[];
  proposal_hash: string;
  agent_label: string;
  status: string;
  expires_at: string;
  result: { object_id?: string; event_id?: string; audit_id?: string; status?: string; readback?: string };
};
export type TAgentOperationState = {
  connection_ttl_seconds?: number;
  enabled: boolean;
  can_configure: boolean;
  csrf_token: string;
  allowed_actions: TAgentAction[];
  operations: TAgentOperation[];
  next_cursor: string | null;
  report_options: { id: string; title: string; version: number }[];
  grants: { context_id: string; expires_at: string; agent_label: string; actions: TAgentAction[] }[];
};
export type TAgentConnection = {
  context_id: string;
  expires_at: string;
  mcp_path: string;
  headers: Record<string, string>;
};

export class ResearchAgentOperationService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  private path(workspace: string, node: string) {
    return `/api/research/workspaces/${encodeURIComponent(workspace)}/nodes/${encodeURIComponent(node)}/agent-operations/`;
  }

  async getState(workspace: string, node: string, params: Record<string, string> = {}): Promise<TAgentOperationState> {
    return this.get(this.path(workspace, node), { params })
      .then((response) => response.data)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async act<T>(workspace: string, node: string, csrf: string, data: Record<string, unknown>): Promise<T> {
    return this.post(this.path(workspace, node), data, { headers: { "X-CSRFToken": csrf } })
      .then((response) => response.data)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }
}
