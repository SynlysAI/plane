/** 使用真实列表、详情和行动项组件验证基础研究链，服务数据保存在内存中。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { setLanguage, TranslationProvider } from "@plane/i18n";
import type { TResearchAssignableUser, TResearchChain, TResearchChainNode, TResearchChainNodeTask } from "@plane/types";
import { StoreProvider, store } from "@/lib/store-context";
import { ResearchChainBoard } from "@/components/research/chains/research-chain-board";
import { ResearchChainDetail } from "@/components/research/chains/research-chain-detail";
import { ResearchChainService } from "@/services/research/chain.service";
import { ResearchChainTaskService } from "@/services/research/chain-task.service";
import { ResearchOrgService } from "@/services/research/org.service";
import { WorkspaceService } from "@/services/workspace.service";
// oxlint-disable-next-line import/no-unassigned-import -- 验收使用应用真实样式。
import "../../styles/globals.css";

const actor = new URLSearchParams(window.location.search).get("actor") === "reader" ? "reader" : "assignee";
const timestamp = "2026-11-06T02:00:00Z";
const candidates: TResearchAssignableUser[] = [
  {
    user_id: "owner",
    display_name: "原指派人",
    org_unit_id: "basic",
    org_unit_name: "基础研究组",
    org_role: "REVIEWER",
    is_primary: true,
    scope: "WORKSPACE",
  },
  {
    user_id: "assignee",
    display_name: "跨组承办人",
    org_unit_id: "other",
    org_unit_name: "材料研究组",
    org_role: "REVIEWER",
    is_primary: true,
    scope: "WORKSPACE",
  },
  {
    user_id: "reader",
    display_name: "科研查看者",
    org_unit_id: "other",
    org_unit_name: "材料研究组",
    org_role: "REVIEWER",
    is_primary: true,
    scope: "WORKSPACE",
  },
];

/** 生成隔离数据中的能力决策。 */
const decision = (allowed: boolean) => ({ allowed, reason_code: "fixture", reason: "隔离验收" });

const chain: TResearchChain = {
  schema_version: "research-chain.v1",
  id: "basic-chain",
  project: "basic-project",
  project_name: "界面催化反应机理研究",
  project_identifier: "BR-01",
  workspace: "basic-workspace",
  owner: "owner",
  owner_name: "原指派人",
  org_unit_name: "基础研究组",
  status: "ACTIVE",
  visibility: "PRIVATE",
  effective_visibility: "WORKSPACE",
  open_task_count: 1,
  created_at: timestamp,
  updated_at: timestamp,
};

const node: TResearchChainNode = {
  schema_version: "research-node.v1",
  id: "basic-node",
  chain: chain.id,
  title: "实验验证",
  node_type: "EXPERIMENT",
  parent_node: null,
  loop_iteration: 0,
  status: "ACTIVE",
  assignee: "owner",
  created_at: timestamp,
  updated_at: timestamp,
};

let task: TResearchChainNodeTask = {
  schema_version: "research-node-task.v1",
  id: "basic-task",
  workspace: chain.workspace,
  chain: chain.id,
  node: node.id,
  title: "核对催化反应对照实验",
  instruction: "<p>补充对照组结果，确认重复实验记录。</p>",
  instruction_attachments: [],
  status: "ASSIGNED",
  assignee: "assignee",
  assignee_detail: { id: "assignee", display_name: "跨组承办人" },
  assignee_is_valid: true,
  assigned_by: "owner",
  assigned_by_detail: { id: "owner", display_name: "原指派人" },
  completed_by: null,
  due_at: null,
  completed_at: null,
  resource_type: "NONE",
  resource_id: null,
  request_id: "fixture-task",
  created_at: timestamp,
  updated_at: timestamp,
};

/** 模拟服务端基于当前承办人返回的独立能力。 */
function taskResponse(): TResearchChainNodeTask {
  const ownsTask = actor === task.assignee;
  return {
    ...task,
    capabilities: {
      schema_version: "research-capabilities.v1",
      actions: {
        view: decision(true),
        edit: decision(false),
        assign: decision(ownsTask),
        complete: decision(ownsTask),
        reopen: decision(false),
        cancel: decision(false),
        delete: decision(false),
      },
    },
  };
}

store.workspaceRoot.workspaces[chain.workspace] = {
  id: chain.workspace,
  slug: "basic-lab",
  name: "科研工作区",
} as never;
WorkspaceService.prototype.fetchWorkspaceMembers = async () => [];
ResearchOrgService.prototype.getOrgUnits = async () => ({ results: [], count: 0 });
ResearchChainService.prototype.getChainPage = async () => ({
  results: [chain],
  next_cursor: "",
  prev_cursor: "",
  next_page_results: false,
  prev_page_results: false,
});
ResearchChainService.prototype.getChain = async () => chain;
ResearchChainService.prototype.getChainNodes = async () => [node];
ResearchChainService.prototype.getChainMembers = async () => [];
ResearchChainService.prototype.getChainNodeDetail = async () => ({ node, events: [], snapshots: [] });
ResearchChainService.prototype.getChainStageApprovals = async () => ({
  chain: chain.id,
  chain_status: "ACTIVE",
  stages: [],
  progress: {
    total: 1,
    approved: 0,
    awaiting_advisor: 0,
    awaiting_pi: 0,
    needs_revision: 0,
    in_progress: 1,
    not_started: 0,
  },
});
ResearchChainService.prototype.getKnowledgeBases = async () => ({
  items: [],
  degraded: false,
  degraded_reason: "",
  state: "READY",
  request_id: "fixture-knowledge",
  scope: "LEGACY_CHAIN",
  orgUnitId: "basic",
  orgUnitName: "基础研究组",
  connectionStatus: "",
  candidates: [],
  uploadLimits: { pdf_max_mb: 500, markdown_max_mb: 500, office_max_mb: 500 },
});
ResearchChainService.prototype.getKnowledgeUploads = async () => ({ data: [] });
ResearchChainTaskService.prototype.getAssignableUsers = async () => candidates;
ResearchChainTaskService.prototype.getNodeTaskList = async () => ({ tasks: [taskResponse()], can_create: false });
ResearchChainTaskService.prototype.getNodeEvents = async () => [];
ResearchChainTaskService.prototype.getTaskComments = async () => ({ results: [], can_comment: false });
ResearchChainTaskService.prototype.getTaskCommentAttachmentLimits = async () => ({
  image: { max_mb: 20, max_bytes: 20 * 1024 * 1024 },
  pdf: { max_mb: 100, max_bytes: 100 * 1024 * 1024 },
  markdown: { max_mb: 5, max_bytes: 5 * 1024 * 1024 },
  office: { max_mb: 50, max_bytes: 50 * 1024 * 1024 },
});
ResearchChainTaskService.prototype.getNotificationRecipients = async () => ({
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
ResearchChainTaskService.prototype.updateNodeTask = async (_workspace, _chain, _node, _task, payload) => {
  if (actor !== task.assignee || Object.keys(payload).join() !== "assignee") throw new Error("无转派权限");
  const next = candidates.find((candidate) => candidate.user_id === payload.assignee);
  if (!next) throw new Error("候选人无效");
  task = { ...task, assignee: next.user_id, assignee_detail: { id: next.user_id, display_name: next.display_name } };
  document.documentElement.dataset.transferPayload = JSON.stringify(payload);
  return taskResponse();
};

const initialEntry =
  new URLSearchParams(window.location.search).get("detail") === "1"
    ? "/basic-lab/research/chains/basic-chain?tab=nodes&node=basic-node"
    : "/basic-lab/research/chains";

await setLanguage("zh-CN");
createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <TranslationProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <main className="h-screen overflow-auto bg-canvas">
          <Routes>
            <Route
              path="/basic-lab/research/chains"
              element={
                <div className="p-5">
                  <ResearchChainBoard workspaceSlug="basic-lab" />
                </div>
              }
            />
            <Route
              path="/basic-lab/research/chains/:chainId"
              element={<ResearchChainDetail workspaceSlug="basic-lab" chainId={chain.id} />}
            />
          </Routes>
        </main>
      </MemoryRouter>
    </TranslationProvider>
  </StoreProvider>
);
