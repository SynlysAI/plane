// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  createMany: vi.fn(),
  fetchActivities: vi.fn(),
  setLastWidgetAction: vi.fn(),
  setToast: vi.fn(),
  limits: vi.fn(),
  attachmentIds: [] as string[],
}));

vi.mock("@/hooks/use-file-size", () => ({ useFileSize: () => ({ maxFileSize: 5 * 1024 * 1024 }) }));
vi.mock("@/hooks/use-issue-attachment-limits", () => ({
  useIssueAttachmentLimits: (...args: unknown[]) => {
    const result = mocks.limits(...args);
    return {
      ...result,
      isLoading: !result.limits && !result.error,
      maxFileSize: result.limits ? Math.max(...Object.values(result.limits).map((limit) => limit.max_bytes)) : 0,
      getLimitError: (file: File) => {
        if (!result.limits) return "无法获取当前工作区附件限制";
        if (file.type.startsWith("image/") && file.size > result.limits.image.max_bytes)
          return `图片文件不能超过 ${result.limits.image.max_mb} MB。`;
        if (file.type.includes("presentation") && file.size > result.limits.office.max_bytes)
          return `办公文件不能超过 ${result.limits.office.max_mb} MB。`;
        return null;
      },
    };
  },
}));
vi.mock("@/components/comments/use-comment-attachment-limits", () => ({
  useCommentAttachmentLimits: (...args: unknown[]) => mocks.limits(...args),
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    fetchActivities: mocks.fetchActivities,
    setLastWidgetAction: mocks.setLastWidgetAction,
    toggleDeleteAttachmentModal: vi.fn(),
    attachmentDeleteModalId: null,
    attachment: {
      createAttachment: mocks.create,
      removeAttachment: vi.fn(),
      getAttachmentsByIssueId: () => mocks.attachmentIds,
      getAttachmentsUploadStatusByIssueId: () => [],
    },
  }),
}));
vi.mock("@/components/issues/attachment/attachment-list-item", () => ({ IssueAttachmentsListItem: () => null }));
vi.mock("@/components/issues/attachment/attachment-list-upload-item", () => ({
  IssueAttachmentsUploadItem: () => null,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key === "attachment.count_limit" ? `每个工作项最多附加 ${values?.count} 个文件。` : key,
  }),
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { ERROR: "error" },
  setPromiseToast: vi.fn(),
  setToast: mocks.setToast,
}));

const { IssueAttachmentActionButton } =
  await import("@/components/issues/issue-detail-widgets/attachments/quick-action-button");
const { IssueAttachmentUpload } = await import("@/components/issues/attachment/attachment-upload");
const { IssueAttachmentDropZone } = await import("@/components/issues/attachment/attachment-drop-zone");

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const MEGABYTE = 1024 * 1024;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const limits = {
  image: { max_mb: 20, max_bytes: 20 * MEGABYTE },
  pdf: { max_mb: 100, max_bytes: 100 * MEGABYTE },
  markdown: { max_mb: 5, max_bytes: 5 * MEGABYTE },
  office: { max_mb: 50, max_bytes: 50 * MEGABYTE },
};

/** 构造带分类校验的额度 hook 返回值。 */
function configuredLimits() {
  return {
    limits,
    error: false,
  };
}

/** 挂载待测上传入口。 */
async function mount(element: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(element));
  await act(async () => await Promise.resolve());
}

/** 模拟浏览器文件选择。 */
async function selectFile(selectedFile: File) {
  await selectFiles([selectedFile]);
}

/** 模拟浏览器多文件选择。 */
async function selectFiles(selectedFiles: File[]) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: selectedFiles });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => await Promise.resolve());
}

/** 创建可覆盖 size 属性的文件。 */
function makeFile(name: string, type: string, size: number) {
  const result = new File(["plane"], name, { type });
  Object.defineProperty(result, "size", { value: size });
  return result;
}

/** 构造满足附件操作形状的测试对象。 */
function attachmentOperations() {
  return {
    create: mocks.create,
    createMany: mocks.createMany,
    remove: vi.fn(),
  };
}

beforeEach(() => {
  mocks.create.mockResolvedValue(undefined);
  mocks.createMany.mockResolvedValue(undefined);
  mocks.limits.mockReturnValue(configuredLimits());
  mocks.attachmentIds = [];
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  vi.clearAllMocks();
});

it("uploads file batches from the quick action and standalone upload area", async () => {
  const files = [
    makeFile("第一份.pptx", "application/octet-stream", 1024),
    makeFile("第二份.md", "text/markdown", 2048),
  ];

  await mount(
    <IssueAttachmentActionButton workspaceSlug="lab" projectId="project" issueId="issue" issueServiceType="issues" />
  );
  await selectFiles(files);
  expect(mocks.create).toHaveBeenNthCalledWith(1, "lab", "project", "issue", files[0]);
  expect(mocks.create).toHaveBeenNthCalledWith(2, "lab", "project", "issue", files[1]);

  await act(async () => root!.unmount());
  await mount(
    <IssueAttachmentUpload
      workspaceSlug="lab"
      projectId="project"
      issueId="issue"
      attachmentOperations={{ createMany: mocks.createMany }}
    />
  );
  await selectFiles(files);
  expect(mocks.createMany).toHaveBeenCalledWith(files);
});

it("uploads a dropped batch from the attachment content area without a click input", async () => {
  const files = [makeFile("报告.pdf", "application/pdf", 1024), makeFile("数据.csv", "text/csv", 2048)];
  await mount(
    <IssueAttachmentDropZone
      workspaceSlug="lab"
      projectId="project"
      issueId="issue"
      attachmentHelpers={{ operations: attachmentOperations(), snapshot: { uploadStatus: [] } }}
      hasContent
    >
      <div>attachments</div>
    </IssueAttachmentDropZone>
  );

  const dropTarget = container.querySelector<HTMLDivElement>("[role='presentation']");
  expect(dropTarget).not.toBeNull();
  expect(container.querySelector('input[type="file"]')).toBeNull();

  const dataTransfer = {
    files,
    items: files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    types: ["Files"],
  };
  const dragEnter = new Event("dragenter", { bubbles: true });
  Object.defineProperty(dragEnter, "dataTransfer", { value: dataTransfer });
  const drop = new Event("drop", { bubbles: true });
  Object.defineProperty(drop, "dataTransfer", { value: dataTransfer });

  await act(async () => dropTarget!.dispatchEvent(dragEnter));
  expect(dropTarget!.className).toContain("border-accent-strong");
  expect(dropTarget!.className).toContain("bg-accent-primary/5");

  await act(async () => {
    dropTarget!.dispatchEvent(drop);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(mocks.createMany).toHaveBeenCalledWith(files);
});

it("blocks an oversized image in the standalone upload area", async () => {
  await mount(
    <IssueAttachmentUpload
      workspaceSlug="lab"
      projectId="project"
      attachmentOperations={{ createMany: mocks.createMany }}
    />
  );
  await selectFile(makeFile("现场照片.png", "image/png", 21 * MEGABYTE));
  expect(mocks.create).not.toHaveBeenCalled();
  expect(container.textContent).toContain("图片文件不能超过 20 MB。");
});

it("blocks an oversized image from the quick action with the category limit", async () => {
  await mount(
    <IssueAttachmentActionButton workspaceSlug="lab" projectId="project" issueId="issue" issueServiceType="issues" />
  );
  await selectFile(makeFile("现场照片.png", "image/png", 21 * MEGABYTE));
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ message: "图片文件不能超过 20 MB。" }));
});

it("allows a six MB office attachment in the standalone upload area", async () => {
  await mount(
    <IssueAttachmentUpload
      workspaceSlug="lab"
      projectId="project"
      attachmentOperations={{ createMany: mocks.createMany }}
    />
  );
  await selectFile(
    makeFile("行政材料.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", 6 * MEGABYTE)
  );
  expect(mocks.createMany).toHaveBeenCalledTimes(1);
});

it("blocks attachment upload when workspace limits cannot be loaded", async () => {
  mocks.limits.mockReturnValue({
    limits: null,
    error: true,
  });
  await mount(
    <IssueAttachmentUpload
      workspaceSlug="lab"
      projectId="project"
      attachmentOperations={{ createMany: mocks.createMany }}
    />
  );
  await selectFile(
    makeFile("行政材料.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", 1024)
  );
  expect(mocks.createMany).not.toHaveBeenCalled();
  expect(mocks.limits).toHaveBeenCalledWith("lab", "project");
  expect(container.textContent).toContain("无法获取当前工作区附件限制");
});

it("blocks the fifty-first attachment from the quick action", async () => {
  mocks.attachmentIds = Array.from({ length: 50 }, (_, index) => `asset-${index}`);
  await mount(
    <IssueAttachmentActionButton workspaceSlug="lab" projectId="project" issueId="issue" issueServiceType="issues" />
  );
  await selectFile(makeFile("第五十一份.pptx", "application/octet-stream", 1024));
  expect(mocks.createMany).not.toHaveBeenCalled();
  expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ message: "每个工作项最多附加 50 个文件。" }));
});

it("blocks the fifty-first attachment from the standalone upload area", async () => {
  mocks.attachmentIds = Array.from({ length: 50 }, (_, index) => `asset-${index}`);
  await mount(
    <IssueAttachmentUpload
      workspaceSlug="lab"
      projectId="project"
      issueId="issue"
      attachmentOperations={{ createMany: mocks.createMany }}
    />
  );
  await selectFile(makeFile("第五十一份.pptx", "application/octet-stream", 1024));
  expect(mocks.createMany).not.toHaveBeenCalled();
  expect(container.textContent).toContain("每个工作项最多附加 50 个文件。");
});
