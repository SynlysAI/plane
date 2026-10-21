// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  fetchActivities: vi.fn(),
  setLastWidgetAction: vi.fn(),
  setToast: vi.fn(),
  limits: vi.fn(),
}));

vi.mock("@/hooks/use-file-size", () => ({ useFileSize: () => ({ maxFileSize: 5 * 1024 * 1024 }) }));
vi.mock("@/hooks/use-issue-attachment-limits", () => ({
  useIssueAttachmentLimits: (...args: unknown[]) => mocks.limits(...args),
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    fetchActivities: mocks.fetchActivities,
    setLastWidgetAction: mocks.setLastWidgetAction,
    toggleDeleteAttachmentModal: vi.fn(),
    attachmentDeleteModalId: null,
    attachment: { getAttachmentsByIssueId: () => [] },
  }),
}));
vi.mock("@/components/issues/issue-detail-widgets/attachments/helper", () => ({
  useAttachmentOperations: () => ({ operations: { create: mocks.create }, snapshot: { uploadStatus: [] } }),
}));
vi.mock("@/components/issues/attachment/attachment-list-item", () => ({ IssueAttachmentsListItem: () => null }));
vi.mock("@/components/issues/attachment/attachment-list-upload-item", () => ({
  IssueAttachmentsUploadItem: () => null,
}));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/propel/toast", () => ({ TOAST_TYPE: { ERROR: "error" }, setToast: mocks.setToast }));

const { IssueAttachmentActionButton } =
  await import("@/components/issues/issue-detail-widgets/attachments/quick-action-button");
const { IssueAttachmentItemList } = await import("@/components/issues/attachment/attachment-item-list");
const { IssueAttachmentUpload } = await import("@/components/issues/attachment/attachment-upload");

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
    isLoading: false,
    maxFileSize: 100 * MEGABYTE,
    getLimitError: (uploadedFile: File) => {
      if (uploadedFile.name.endsWith(".png") && uploadedFile.size > limits.image.max_bytes) {
        return "图片文件不能超过 20 MB。";
      }
      if (uploadedFile.name.endsWith(".pptx") && uploadedFile.size > limits.office.max_bytes) {
        return "办公及其他附件不能超过 50 MB。";
      }
      return null;
    },
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
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [selectedFile] });
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

beforeEach(() => {
  mocks.create.mockResolvedValue(undefined);
  mocks.limits.mockReturnValue(configuredLimits());
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  vi.clearAllMocks();
});

it("allows a six MB office attachment in the issue attachment list", async () => {
  await mount(
    <IssueAttachmentItemList
      workspaceSlug="lab"
      projectId="project"
      issueId="issue"
      attachmentHelpers={{ operations: { create: mocks.create }, snapshot: { uploadStatus: [] } }}
    />
  );
  await selectFile(
    makeFile("行政材料.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", 6 * MEGABYTE)
  );
  expect(mocks.create).toHaveBeenCalledTimes(1);
});

it("blocks an oversized image from the quick action with the category limit", async () => {
  await mount(
    <IssueAttachmentActionButton workspaceSlug="lab" projectId="project" issueId="issue" issueServiceType="issues" />
  );
  await selectFile(makeFile("现场照片.png", "image/png", 21 * MEGABYTE));
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ message: "图片文件不能超过 20 MB。" }));
});

it("blocks attachment upload when workspace limits cannot be loaded", async () => {
  mocks.limits.mockReturnValue({
    limits: null,
    error: true,
    isLoading: false,
    maxFileSize: 0,
    getLimitError: () => "无法获取当前工作区附件限制",
  });
  await mount(
    <IssueAttachmentUpload workspaceSlug="lab" projectId="project" attachmentOperations={{ create: mocks.create }} />
  );
  await selectFile(
    makeFile("行政材料.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", 1024)
  );
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.limits).toHaveBeenCalledWith("lab", "project");
  expect(container.textContent).toContain("无法获取当前工作区附件限制");
});
