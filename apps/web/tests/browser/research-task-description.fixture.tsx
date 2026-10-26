import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { setLanguage, TranslationProvider } from "@plane/i18n";
import type { TResearchChainNodeTask, TResearchTaskInstructionAttachment } from "@plane/types";
import { StoreProvider, store } from "@/lib/store-context";
import { ResearchTaskDescription } from "@/components/research/chains/research-task-description";
import { ResearchChainTaskService } from "@/services/research/chain-task.service";
// oxlint-disable-next-line import/no-unassigned-import -- 验收使用应用真实样式。
import "../../styles/globals.css";

store.workspaceRoot.workspaces.workspace = { id: "workspace", slug: "lab", name: "公共科研工作区" } as never;

const task = {
  schema_version: "research-node-task.v1",
  id: "task-1",
  workspace: "workspace",
  chain: "chain-1",
  node: "node-1",
  title: "整理实验记录",
  instruction: "<p>补充样本量与误差棒说明。</p>",
  instruction_attachments: [],
  status: "DRAFT",
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

const limits = {
  image: { max_mb: 20, max_bytes: 20 * 1024 * 1024 },
  pdf: { max_mb: 100, max_bytes: 100 * 1024 * 1024 },
  markdown: { max_mb: 5, max_bytes: 5 * 1024 * 1024 },
  office: { max_mb: 50, max_bytes: 50 * 1024 * 1024 },
};

ResearchChainTaskService.prototype.getTaskCommentAttachmentLimits = async () => limits;
ResearchChainTaskService.prototype.uploadTaskInstructionImage = async (_workspace, _chain, _node, _task, file) =>
  URL.createObjectURL(file);
ResearchChainTaskService.prototype.deleteTaskInstructionImage = async () => undefined;
ResearchChainTaskService.prototype.restoreTaskInstructionImage = async () => undefined;
ResearchChainTaskService.prototype.uploadTaskInstructionAttachment = async (_workspace, _chain, _node, _task, file) =>
  ({
    id: `asset-${file.name}`,
    name: file.name,
    type: file.type,
    size: file.size,
    download_url: URL.createObjectURL(file),
  }) as TResearchTaskInstructionAttachment;
ResearchChainTaskService.prototype.deleteTaskInstructionAttachment = async () => undefined;

/** Render the real task-description editor with an in-memory service boundary. */
function Fixture() {
  const [instruction, setInstruction] = useState(task.instruction);
  const [editable, setEditable] = useState(true);

  return (
    <main className="bg-background mx-auto min-h-screen max-w-4xl p-5 sm:p-8">
      <header className="mb-6 border-b border-subtle pb-4">
        <p className="text-12 text-tertiary">科研链 / 实验记录节点</p>
        <h1 className="text-22 mt-1 font-semibold text-primary">整理实验记录</h1>
        <button
          type="button"
          className="mt-3 rounded-md border border-subtle bg-surface-2 px-2 py-1 text-12 text-secondary"
          onClick={() => setEditable((current) => !current)}
        >
          {editable ? "切换只读" : "切换编辑"}
        </button>
      </header>
      <section className="rounded-lg border border-subtle bg-surface-1 px-4 py-3">
        <ResearchTaskDescription
          task={task}
          workspaceSlug="lab"
          value={instruction}
          editable={editable}
          onChange={setInstruction}
          onAttachmentsChange={() => undefined}
          onBusyChange={() => undefined}
        />
      </section>
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
