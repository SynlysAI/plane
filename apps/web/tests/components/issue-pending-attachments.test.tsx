// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  limits: vi.fn(),
  onAdd: vi.fn(),
  onRemove: vi.fn(),
  onValidationChange: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      ({
        "attachment.count_limit": `每个工作项最多附加 ${values?.count} 个文件。`,
        "attachment.create.hint": "保存工作项后自动上传。",
        "attachment.create.remove": "移除附件",
        "attachment.create.title": "附件",
        "attachment.create.zone_title": "拖拽或点击选择附件（可多选）",
        "attachment.upload_zone.active": "松开以添加",
        "attachment.upload_zone.empty": "没有可选择的上传文件。",
        "attachment.upload_zone.invalid": "文件不符合上传要求。",
        "attachment.upload_zone.invalid_type": "包含不支持的文件类型。",
        "attachment.upload_zone.too_large": "文件超过大小限制。",
      })[key]?.replace("{count}", String(values?.count ?? "")) ?? key,
  }),
}));
vi.mock("@/components/comments/use-comment-attachment-limits", () => ({
  useCommentAttachmentLimits: (...args: unknown[]) => mocks.limits(...args),
}));

const { IssuePendingAttachments, uploadPendingIssueAttachments } =
  await import("@/components/issues/issue-modal/components/pending-attachments");

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

const MEGABYTE = 1024 * 1024;
let container: HTMLDivElement;
let root: Root | null = null;

/** 挂载创建态附件组件。 */
async function mount() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <IssuePendingAttachments
        attachments={[]}
        onAdd={mocks.onAdd}
        onRemove={mocks.onRemove}
        onValidationChange={mocks.onValidationChange}
        projectId="project-1"
        workspaceSlug="lab"
      />
    );
  });
}

/** 模拟文件选择。 */
async function selectFiles(files: File[]) {
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => await Promise.resolve());
}

/** 创建可指定大小的文件。 */
function file(name: string, type: string, size: number) {
  const result = new File(["plane"], name, { type });
  Object.defineProperty(result, "size", { value: size });
  return result;
}

beforeEach(() => {
  mocks.limits.mockReturnValue({
    limits: {
      image: { max_mb: 20, max_bytes: 20 * MEGABYTE },
      pdf: { max_mb: 100, max_bytes: 100 * MEGABYTE },
      markdown: { max_mb: 5, max_bytes: 5 * MEGABYTE },
      office: { max_mb: 50, max_bytes: 50 * MEGABYTE },
    },
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  vi.clearAllMocks();
});

it("adds a selected file batch without partial writes", async () => {
  await mount();
  const first = file("材料一.pdf", "application/pdf", MEGABYTE);
  const second = file(
    "材料二.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    MEGABYTE
  );
  await selectFiles([first, second]);

  expect(mocks.onAdd).toHaveBeenCalledTimes(1);
  expect(mocks.onAdd).toHaveBeenCalledWith([first, second]);
  expect(mocks.onValidationChange).toHaveBeenLastCalledWith(null);
});

it("blocks an oversized attachment before it enters the queue", async () => {
  await mount();
  await selectFiles([file("超限.png", "image/png", 21 * MEGABYTE)]);

  expect(mocks.onAdd).not.toHaveBeenCalled();
  expect(container.textContent).toContain("图片文件不能超过 20 MB。");
});

it("reports the queue error when the work item limit would be exceeded", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const attachments = Array.from({ length: 50 }, (_, index) => ({
    id: `attachment-${index}`,
    file: file(`材料-${index}.pdf`, "application/pdf", MEGABYTE),
  }));

  await act(async () => {
    root!.render(
      <IssuePendingAttachments
        attachments={attachments}
        onAdd={mocks.onAdd}
        onRemove={mocks.onRemove}
        onValidationChange={mocks.onValidationChange}
        projectId="project-1"
        workspaceSlug="lab"
      />
    );
  });
  await selectFiles([file("第五十一份.pdf", "application/pdf", MEGABYTE)]);

  expect(mocks.onAdd).not.toHaveBeenCalled();
  expect(container.textContent).toContain("每个工作项最多附加 50 个文件。");
});

it("continues uploading remaining files and reports only failures", async () => {
  const createAttachment = vi
    .fn()
    .mockResolvedValueOnce({ id: "first" })
    .mockRejectedValueOnce(new Error("second failed"))
    .mockResolvedValueOnce({ id: "third" });
  const failedNames = await uploadPendingIssueAttachments({
    createAttachment,
    issueId: "issue-1",
    pendingAttachments: [
      { id: "one", file: file("一.pdf", "application/pdf", MEGABYTE) },
      { id: "two", file: file("二.pdf", "application/pdf", MEGABYTE) },
      { id: "three", file: file("三.pdf", "application/pdf", MEGABYTE) },
    ],
    projectId: "project-1",
    workspaceSlug: "lab",
  });

  expect(createAttachment).toHaveBeenCalledTimes(3);
  expect(createAttachment.mock.calls.map((call) => call[3].name)).toEqual(["一.pdf", "二.pdf", "三.pdf"]);
  expect(failedNames).toEqual(["二.pdf"]);
});
