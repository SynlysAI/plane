import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { setLanguage, TranslationProvider } from "@plane/i18n";
import type { TResearchChainNodeTask } from "@plane/types";
import { ResearchTaskComments } from "@/components/research/chains/research-task-comments";
import { ResearchChainTaskService } from "@/services/research/chain-task.service";
import { StoreProvider, store } from "@/lib/store-context";
// oxlint-disable-next-line import/no-unassigned-import -- 验收使用应用真实样式。
import "../../styles/globals.css";

const LIMITS = {
  image: { max_mb: 20, max_bytes: 20 * 1024 * 1024 },
  pdf: { max_mb: 100, max_bytes: 100 * 1024 * 1024 },
  markdown: { max_mb: 5, max_bytes: 5 * 1024 * 1024 },
  office: { max_mb: 50, max_bytes: 50 * 1024 * 1024 },
};

store.workspaceRoot.workspaces.workspace = { id: "workspace", slug: "lab", name: "公共科研工作区" } as never;

const task = {
  schema_version: "research-node-task.v1",
  id: "task-1",
  workspace: "workspace",
  chain: "chain-1",
  node: "node-1",
  title: "整理实验记录",
  instruction: "<p>请补充过程记录。</p>",
  instruction_attachments: [],
  status: "ASSIGNED",
  assignee: null,
  assignee_is_valid: false,
  assigned_by: null,
  due_at: null,
  submitted_at: null,
  completed_at: null,
  resource_type: "NONE",
  resource_id: null,
  request_id: "request-1",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
} as TResearchChainNodeTask;

ResearchChainTaskService.prototype.getTaskComments = async () => ({ results: [], can_comment: true });
ResearchChainTaskService.prototype.createTaskComment = async (_workspace, _chain, _node, _task, payload) => ({
  id: `comment-${crypto.randomUUID()}`,
  task: task.id,
  actor: "author",
  actor_detail: { id: "author", display_name: "方奕凯", avatar_url: null },
  comment_html: payload.comment_html,
  comment_stripped: "评论已保存",
  can_edit: true,
  can_delete: true,
  edited_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  file_attachments: [],
});
ResearchChainTaskService.prototype.getTaskCommentAttachmentLimits = async () => LIMITS;
ResearchChainTaskService.prototype.uploadTaskCommentAttachment = async (_workspace, _chain, _node, _task, file) => ({
  id: `asset-${file.name}`,
  name: file.name,
  type: file.type,
  size: file.size,
  download_url: URL.createObjectURL(file),
});
ResearchChainTaskService.prototype.deleteTaskCommentAttachment = async () => undefined;
ResearchChainTaskService.prototype.uploadTaskCommentImage = async (_workspace, _chain, _node, _task, file) =>
  URL.createObjectURL(file);
ResearchChainTaskService.prototype.deleteTaskCommentImage = async () => undefined;

/** Render the real research task comment editor with an in-memory service boundary. */
function Fixture() {
  return (
    <main className="mx-auto min-h-screen max-w-4xl bg-surface-1 p-5 text-primary sm:p-8">
      <header className="mb-6 border-b border-subtle pb-4">
        <p className="mb-2 text-12 text-tertiary">科研链 / 实验记录节点</p>
        <h1 className="text-22 font-semibold">整理实验记录</h1>
        <p className="mt-2 text-13 text-secondary">任务评论支持拖拽上传过程附件</p>
      </header>
      <ResearchTaskComments task={task} workspaceSlug="lab" locale="zh-CN" order="desc" />
    </main>
  );
}

void setLanguage("zh-CN");
createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    <TranslationProvider>
      <StoreProvider store={store}>
        <Fixture />
      </StoreProvider>
    </TranslationProvider>
  </MemoryRouter>
);
