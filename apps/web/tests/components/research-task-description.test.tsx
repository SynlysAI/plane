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

/**
 * 创建一个可手动完成或失败的 Promise，用于精确控制上传时机。
 */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

/**
 * 向任务说明附件输入框写入文件并触发上传。
 */
async function selectAttachmentFiles(input: HTMLInputElement, files: File[]) {
  await act(async () => {
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function renderDescription(
  overrides: { value?: string; editable?: boolean; task?: Partial<TResearchChainNodeTask> } = {}
) {
  const { ResearchTaskDescription } = await import("@/components/research/chains/research-task-description");
  await act(async () => {
    root.render(
      <ResearchTaskDescription
        task={{
          ...task,
          instruction: overrides.value ?? task.instruction,
          ...overrides.task,
        }}
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

/** 通过原生文件事件一次选择多个任务描述附件。 */
async function selectFiles(files: File[]) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => await Promise.resolve());
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
  await expect(capturedEditor.props?.fileHandlerOverrides.getAssetSrc(source)).resolves.toBe(source);
  await expect(capturedEditor.props?.fileHandlerOverrides.getAssetDownloadSrc(source)).resolves.toBe(
    `${source}?download=1`
  );
  await expect(capturedEditor.props?.fileHandlerOverrides.getAssetDownloadSrc("/external/image.png")).resolves.toBe(
    "/external/image.png"
  );
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
  expect(capturedEditor.props.onAttachFiles).toBeTypeOf("function");
  expect(container.textContent).not.toContain("拖拽文件或文件夹到这里，或点击选择");

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

it("keeps an uploading attachment when the parent echoes an empty attachment list", async () => {
  const upload = createDeferred<{
    id: string;
    name: string;
    type: string;
    size: number;
    download_url: string;
  }>();
  const attachment = {
    id: "asset-attachment-1",
    name: "过程说明.pdf",
    type: "application/pdf",
    size: 128,
    download_url: "/api/research/workspaces/lab/instruction-attachments/asset-attachment-1/download/",
  };
  mocks.uploadTaskInstructionAttachment.mockReturnValueOnce(upload.promise);
  await renderDescription({ editable: true });

  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await selectAttachmentFiles(input, [new File(["pdf"], "过程说明.pdf", { type: "application/pdf" })]);
  await renderDescription({ editable: true, task: { instruction_attachments: [] } });

  expect(container.textContent).toContain("过程说明.pdf");
  expect(container.textContent).toContain("上传中");
  expect(mocks.deleteTaskInstructionAttachment).not.toHaveBeenCalled();

  await act(async () => upload.resolve(attachment));
  expect(
    container.querySelector(
      'a[href="/api/research/workspaces/lab/instruction-attachments/asset-attachment-1/download/"]'
    )
  ).not.toBeNull();
  expect(mocks.deleteTaskInstructionAttachment).not.toHaveBeenCalled();
});

it("keeps later uploads when an earlier concurrent attachment is confirmed", async () => {
  const firstUpload = createDeferred<{
    id: string;
    name: string;
    type: string;
    size: number;
    download_url: string;
  }>();
  const secondUpload = createDeferred<{
    id: string;
    name: string;
    type: string;
    size: number;
    download_url: string;
  }>();
  mocks.uploadTaskInstructionAttachment
    .mockReturnValueOnce(firstUpload.promise)
    .mockReturnValueOnce(secondUpload.promise);
  await renderDescription({ editable: true });

  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await selectAttachmentFiles(input, [
    new File(["first"], "第一份.pdf", { type: "application/pdf" }),
    new File(["second"], "第二份.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  ]);

  await act(async () =>
    firstUpload.resolve({
      id: "asset-attachment-1",
      name: "第一份.pdf",
      type: "application/pdf",
      size: 128,
      download_url: "/api/research/workspaces/lab/instruction-attachments/asset-attachment-1/download/",
    })
  );
  expect(container.textContent).toContain("第一份.pdf");
  expect(container.textContent).toContain("第二份.xlsx");
  expect(container.textContent).toContain("上传中");
  expect(mocks.deleteTaskInstructionAttachment).not.toHaveBeenCalled();

  await act(async () =>
    secondUpload.resolve({
      id: "asset-attachment-2",
      name: "第二份.xlsx",
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 256,
      download_url: "/api/research/workspaces/lab/instruction-attachments/asset-attachment-2/download/",
    })
  );
  expect(container.textContent).toContain("第一份.pdf");
  expect(container.textContent).toContain("第二份.xlsx");
  expect(mocks.deleteTaskInstructionAttachment).not.toHaveBeenCalled();
});

it("keeps a failed attachment and retry action after parent list sync", async () => {
  mocks.uploadTaskInstructionAttachment.mockRejectedValueOnce(new Error("upload failed"));
  await renderDescription({ editable: true });

  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  await selectAttachmentFiles(input, [new File(["docx"], "材料.docx", { type: "application/msword" })]);
  await renderDescription({ editable: true, task: { instruction_attachments: [] } });

  expect(container.textContent).toContain("材料.docx");
  expect(container.textContent).toContain("上传失败");
  expect(container.querySelector('button[aria-label="重试上传"]')).not.toBeNull();
  expect(mocks.deleteTaskInstructionAttachment).not.toHaveBeenCalled();
});

it("rebuilds attachment entries when the task changes", async () => {
  await renderDescription({
    editable: true,
    task: {
      instruction_attachments: [
        {
          id: "old-asset",
          name: "旧任务.pdf",
          type: "application/pdf",
          size: 128,
          download_url: "/api/research/workspaces/lab/instruction-attachments/old-asset/download/",
        },
      ],
    },
  });
  expect(container.textContent).toContain("旧任务.pdf");

  await renderDescription({
    editable: true,
    task: {
      id: "task-2",
      instruction_attachments: [
        {
          id: "new-asset",
          name: "新任务.pdf",
          type: "application/pdf",
          size: 128,
          download_url: "/api/research/workspaces/lab/instruction-attachments/new-asset/download/",
        },
      ],
    },
  });
  expect(container.textContent).not.toContain("旧任务.pdf");
  expect(container.textContent).toContain("新任务.pdf");
});

it("allows fifty task-description attachments and blocks the fifty-first", async () => {
  mocks.uploadTaskInstructionAttachment.mockImplementation(
    async (_workspaceSlug: string, _chain: string, _node: string, _task: string, file: File) => ({
      id: `asset-${file.name}`,
      name: file.name,
      type: file.type,
      size: file.size,
      download_url: `/download/${file.name}`,
    })
  );
  await renderDescription({ editable: true });

  await selectFiles(Array.from({ length: 50 }, (_, index) => new File(["pdf"], `过程-${index}.pdf`)));
  expect(mocks.uploadTaskInstructionAttachment).toHaveBeenCalledTimes(50);

  await selectFiles([new File(["pdf"], "第五十一份.pdf")]);
  expect(mocks.uploadTaskInstructionAttachment).toHaveBeenCalledTimes(50);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("任务描述最多附加 50 个文件。");
});
