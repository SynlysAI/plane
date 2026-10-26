// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TResearchChainNodeTask } from "@plane/types";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  getTaskCommentAttachmentLimits: vi.fn(),
  uploadTaskInstructionImage: vi.fn(),
  deleteTaskInstructionImage: vi.fn(),
  restoreTaskInstructionImage: vi.fn(),
  uploadTaskInstructionAttachment: vi.fn(),
  deleteTaskInstructionAttachment: vi.fn(),
}));

const capturedEditor = vi.hoisted(() => ({ props: null as null | Record<string, any> }));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      if (typeof value !== "string") return key;
      return Object.entries(values ?? {}).reduce(
        (text, [name, replacement]) => text.replaceAll(`{${name}}`, String(replacement)),
        value
      );
    },
  }),
}));

vi.mock("@/services/research/chain-task.service", () => ({
  ResearchChainTaskService: class {
    getTaskCommentAttachmentLimits = mocks.getTaskCommentAttachmentLimits;
    uploadTaskInstructionImage = mocks.uploadTaskInstructionImage;
    deleteTaskInstructionImage = mocks.deleteTaskInstructionImage;
    restoreTaskInstructionImage = mocks.restoreTaskInstructionImage;
    uploadTaskInstructionAttachment = mocks.uploadTaskInstructionAttachment;
    deleteTaskInstructionAttachment = mocks.deleteTaskInstructionAttachment;
  },
}));

vi.mock("@/components/editor/rich-text", () => ({
  RichTextEditor: (props: Record<string, any>) => {
    capturedEditor.props = props;
    return <div data-testid="rich-editor">{props.initialValue}</div>;
  },
}));

const limits = {
  image: { max_mb: 20, max_bytes: 20 * 1024 * 1024 },
  pdf: { max_mb: 100, max_bytes: 100 * 1024 * 1024 },
  markdown: { max_mb: 5, max_bytes: 5 * 1024 * 1024 },
  office: { max_mb: 50, max_bytes: 50 * 1024 * 1024 },
};

const task = {
  schema_version: "research-node-task.v1",
  id: "task-1",
  workspace: "workspace-1",
  chain: "chain-1",
  node: "node-1",
  title: "整理实验记录",
  instruction: "<p></p>",
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
} as unknown as TResearchChainNodeTask;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let attachments: { id: string; name: string; type: string; size: number; download_url: string }[];
let busy: boolean;

async function renderDescription(overrides: { value?: string; editable?: boolean } = {}) {
  const { ResearchTaskDescription } = await import("@/components/research/chains/research-task-description");
  await act(async () => {
    root.render(
      <ResearchTaskDescription
        task={{ ...task, instruction: overrides.value ?? task.instruction }}
        workspaceSlug="lab"
        value={overrides.value ?? task.instruction}
        editable={overrides.editable ?? false}
        onChange={() => undefined}
        onAttachmentsChange={(next) => {
          attachments = next;
        }}
        onBusyChange={(next) => {
          busy = next;
        }}
      />
    );
  });
  await act(async () => undefined);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  attachments = [];
  busy = false;
  capturedEditor.props = null;
  mocks.getTaskCommentAttachmentLimits.mockReset().mockResolvedValue(limits);
  mocks.uploadTaskInstructionImage.mockReset();
  mocks.deleteTaskInstructionImage.mockReset().mockResolvedValue(undefined);
  mocks.restoreTaskInstructionImage.mockReset().mockResolvedValue(undefined);
  mocks.uploadTaskInstructionAttachment.mockReset();
  mocks.deleteTaskInstructionAttachment.mockReset().mockResolvedValue(undefined);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("renders one placeholder for empty instructions and treats an image-only instruction as content", async () => {
  await renderDescription({ value: "<p></p>" });
  expect(container.textContent).toContain("暂无任务说明");

  await act(async () => root.render(<div />));
  await renderDescription({
    value:
      '<image-component src="/api/research/workspaces/lab/chains/chain-1/nodes/node-1/tasks/task-1/instruction-images/asset-1/"></image-component>',
  });
  expect(container.textContent).not.toContain("暂无任务说明");
});

it("wires inline image uploads and delete/restore to task-scoped services", async () => {
  mocks.uploadTaskInstructionImage.mockResolvedValue("/instruction-images/asset-1/");
  await renderDescription({ editable: true });
  await act(async () => capturedEditor.props?.uploadFile("block-1", new File([], "figure.png", { type: "image/png" })));
  expect(mocks.uploadTaskInstructionImage).toHaveBeenCalledWith("lab", "chain-1", "node-1", "task-1", expect.any(File));

  const source = "/api/research/workspaces/lab/chains/chain-1/nodes/node-1/tasks/task-1/instruction-images/asset-1/";
  await act(async () => capturedEditor.props?.fileHandlerOverrides.delete(source));
  expect(mocks.deleteTaskInstructionImage).toHaveBeenCalledWith("lab", "chain-1", "node-1", "task-1", "asset-1");
  await act(async () => capturedEditor.props?.fileHandlerOverrides.restore(source));
  expect(mocks.restoreTaskInstructionImage).toHaveBeenCalledWith("lab", "chain-1", "node-1", "task-1", "asset-1");
});

it("uploads, presents, and deletes persisted task attachments", async () => {
  mocks.uploadTaskInstructionAttachment.mockResolvedValue({
    id: "asset-attachment-1",
    name: "过程说明.pdf",
    type: "application/pdf",
    size: 128,
    download_url: "/api/research/workspaces/lab/instruction-attachments/asset-attachment-1/download/",
  });
  await renderDescription({ editable: true });

  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File(["pdf"], "过程说明.pdf", { type: "application/pdf" });
  await act(async () => {
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });

  expect(mocks.uploadTaskInstructionAttachment).toHaveBeenCalledWith("lab", "chain-1", "node-1", "task-1", file);
  expect(attachments).toHaveLength(1);
  expect(
    container.querySelector(
      'a[href="/api/research/workspaces/lab/instruction-attachments/asset-attachment-1/download/"]'
    )
  ).not.toBeNull();

  const remove = [...container.querySelectorAll("button")].find((button) => button.textContent === "移除");
  await act(async () => remove?.click());
  expect(mocks.deleteTaskInstructionAttachment).toHaveBeenCalledWith(
    "lab",
    "chain-1",
    "node-1",
    "task-1",
    "asset-attachment-1"
  );
  expect(attachments).toHaveLength(0);
  expect(busy).toBe(false);
});
