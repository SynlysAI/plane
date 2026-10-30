// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TIssueAttachmentLimitsState } from "@/hooks/use-issue-attachment-limits";

const mocks = vi.hoisted(() => ({
  limits: vi.fn(),
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
async function mount(attachments: { id: string; file: File }[] = [], limitsState?: TIssueAttachmentLimitsState) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <IssuePendingAttachments
        attachments={attachments}
        onRemove={mocks.onRemove}
        onValidationChange={mocks.onValidationChange}
        projectId="project-1"
        workspaceSlug="lab"
        limitsState={limitsState}
      />
    );
  });
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

it("shows a selected file batch and keeps it pending until save", async () => {
  const first = file("材料一.pdf", "application/pdf", MEGABYTE);
  const second = file(
    "材料二.docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    MEGABYTE
  );
  await mount([
    { id: "first", file: first },
    { id: "second", file: second },
  ]);

  expect(container.textContent).toContain("材料一.pdf");
  expect(container.textContent).toContain("材料二.docx");
  expect(mocks.onValidationChange).toHaveBeenLastCalledWith(null);
});

it("uses limits prefetched by the create form instead of issuing another request", async () => {
  const configured = {
    limits: {
      image: { max_mb: 20, max_bytes: 20 * MEGABYTE },
      pdf: { max_mb: 100, max_bytes: 100 * MEGABYTE },
      markdown: { max_mb: 5, max_bytes: 5 * MEGABYTE },
      office: { max_mb: 50, max_bytes: 50 * MEGABYTE },
    },
    error: false,
    isLoading: false,
    maxFileSize: 100 * MEGABYTE,
    getLimitError: (attachment: File) => (attachment.size > 100 * MEGABYTE ? "办公及其他附件不能超过 100 MB。" : null),
  };
  const oversize = file("超大材料.bin", "application/octet-stream", 101 * MEGABYTE);

  await mount([{ id: "oversize", file: oversize }], configured);

  expect(container.textContent).toContain("办公及其他附件不能超过 100 MB。");
  expect(mocks.limits).not.toHaveBeenCalled();
});

it("reports an oversized attachment in the pending queue", async () => {
  await mount([{ id: "oversize", file: file("超限.png", "image/png", 21 * MEGABYTE) }]);

  expect(container.textContent).toContain("图片文件不能超过 20 MB。");
});

it("reports the queue error when the work item limit would be exceeded", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const attachments = Array.from({ length: 51 }, (_, index) => ({
    id: `attachment-${index}`,
    file: file(`材料-${index}.pdf`, "application/pdf", MEGABYTE),
  }));

  await act(async () => {
    root!.render(
      <IssuePendingAttachments
        attachments={attachments}
        onRemove={mocks.onRemove}
        onValidationChange={mocks.onValidationChange}
        projectId="project-1"
        workspaceSlug="lab"
      />
    );
  });

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
