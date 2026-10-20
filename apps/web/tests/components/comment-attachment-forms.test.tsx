// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TCommentsOperations, TIssueComment } from "@plane/types";

const mocks = vi.hoisted(() => ({ bulk: vi.fn(), uploadImage: vi.fn(), limits: vi.fn() }));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "ws" }) }) }));
vi.mock("@/hooks/use-file-size", () => ({ useFileSize: () => ({ maxFileSize: 1024 }) }));
vi.mock("@/services/file.service", () => ({
  FileService: class {
    updateBulkProjectAssetsUploadStatus = mocks.bulk;
    getCommentAttachmentLimits = mocks.limits;
  },
}));
vi.mock("@/components/editor/lite-text", () => ({
  LiteTextEditor: React.forwardRef(function Editor(props: any, ref) {
    const [body, setBody] = React.useState(props.initialValue);
    React.useImperativeHandle(ref, () => ({
      isEditorReadyToDiscard: () =>
        !Array.from(body.matchAll(/<image-component\b([^>]*)>/gi)).some(
          ([, attributes]) => !/\bsrc\s*=\s*["'][^"']+["']/i.test(attributes)
        ),
      clearEditor: () => setBody("<p></p>"),
      setEditorValue: setBody,
      getDocument: () => ({ html: body, json: null, binary: null }),
    }));
    return (
      <div>
        <textarea
          aria-label="评论正文"
          value={body}
          onChange={(event) => {
            setBody(event.target.value);
            props.onChange({}, event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") props.onEnterKeyPress(event);
          }}
        />
        <input
          type="file"
          multiple
          aria-label="选择评论附件"
          onChange={(event) => props.onAttachFiles?.(Array.from(event.target.files ?? []))}
        />
        <button
          onClick={() =>
            void props.uploadFile("block", new File(["image"], "image.png")).then((assetId: string) => {
              const html = `<p><image-component src="${assetId}"></image-component></p>`;
              setBody(html);
              props.onChange({}, html);
              return assetId;
            })
          }
        >
          图片
        </button>
        {props.attachmentContent}
        {props.showSubmitButton !== false && (
          <button
            disabled={
              props.isSubmitting ||
              props.isSubmitDisabled ||
              !ref.current?.isEditorReadyToDiscard() ||
              (!props.hasAttachments && props.initialValue === "<p></p>")
            }
            onClick={props.onEnterKeyPress}
          >
            评论
          </button>
        )}
        <button
          onClick={() => {
            const html = "<p><image-component></image-component></p>";
            setBody(html);
            props.onChange({}, html);
          }}
        >
          未完成图片
        </button>
      </div>
    );
  }),
}));

const { CommentCreate } = await import("@/components/comments/comment-create");
const { CommentCardEditForm } = await import("@/components/comments/card/edit-form");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const file = {
  id: "asset",
  name: "过程.pptx",
  type: "application/octet-stream",
  size: 4,
  download_url: "/download/asset",
};
const limits = {
  image: { max_mb: 1, max_bytes: 1024 * 1024 },
  pdf: { max_mb: 2, max_bytes: 2 * 1024 * 1024 },
  markdown: { max_mb: 3, max_bytes: 3 * 1024 * 1024 },
  office: { max_mb: 4, max_bytes: 4 * 1024 * 1024 },
};

/** 准备评论操作边界，保留真实草稿、表单与附件列表。 */
function operations() {
  return {
    createComment: vi.fn().mockResolvedValue({ id: "comment" }),
    updateComment: vi.fn().mockResolvedValue(undefined),
    uploadCommentAttachment: vi.fn().mockResolvedValue(file),
    discardCommentAttachment: vi.fn().mockResolvedValue(undefined),
    uploadCommentAsset: vi.fn().mockResolvedValue({ asset_id: "image" }),
  } as unknown as TCommentsOperations;
}

/** 挂载新增或编辑表单。 */
async function mount(element: React.ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(element));
  await act(async () => await Promise.resolve());
}

/** 通过原生文件事件添加过程文件。 */
async function attach() {
  await act(async () => {
    const input = container.querySelector('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["pptx"], "过程.pptx")] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** 通过原生文件事件添加指定文件。 */
async function attachFile(inputFile: File) {
  await act(async () => {
    const input = container.querySelector('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [inputFile] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** 点击指定表单操作。 */
async function click(label: string) {
  await act(async () => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === label || item.getAttribute("aria-label") === label
    );
    if (!button) throw new Error(`缺少按钮 ${label}`);
    button.click();
  });
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.limits.mockReset().mockResolvedValue(limits);
});

it("loads project comment attachment limits for create and edit forms", async () => {
  mocks.limits.mockResolvedValue(limits);
  const ops = operations();
  await mount(<CommentCreate workspaceSlug="lab" projectId="project" entityId="issue" activityOperations={ops} />);
  expect(mocks.limits).toHaveBeenCalledWith("lab", "project");
  await act(async () => root.render(null));
  await mount(
    <CommentCardEditForm
      workspaceSlug="lab"
      workspaceId="ws"
      projectId="project"
      comment={{ id: "comment", comment_html: "<p></p>", file_attachments: [] } as unknown as TIssueComment}
      activityOperations={ops}
      isEditing
      readOnlyEditorRef={null}
      setIsEditing={vi.fn()}
    />
  );
  expect(mocks.limits).toHaveBeenLastCalledWith("lab", "project");
});

it("blocks create-form attachments when limits cannot be loaded", async () => {
  mocks.limits.mockRejectedValue(new Error("offline"));
  const ops = operations();
  await mount(<CommentCreate workspaceSlug="lab" projectId="project" entityId="issue" activityOperations={ops} />);
  await act(async () => await Promise.resolve());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("无法获取当前工作区附件限制");
  const large = new File(["pdf"], "large.pdf", { type: "application/pdf" });
  Object.defineProperty(large, "size", { value: 2 * 1024 * 1024 + 1 });
  await attachFile(large);
  expect(ops.uploadCommentAttachment).not.toHaveBeenCalled();
});

it("keeps an attachment-only failed comment and clears only after successful retry", async () => {
  const ops = operations();
  vi.mocked(ops.createComment).mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ id: "comment" });
  await mount(<CommentCreate workspaceSlug="lab" projectId="project" entityId="issue" activityOperations={ops} />);
  await attach();
  await click("评论");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("已保留");
  expect(container.textContent).toContain("过程.pptx");
  await click("评论");
  expect(ops.createComment).toHaveBeenLastCalledWith({ comment_html: "<p></p>", attachment_ids: ["asset"] });
  expect(container.textContent).not.toContain("过程.pptx");
  expect(ops.discardCommentAttachment).not.toHaveBeenCalled();
});

it("associates images with the actual comment id and reuses it when association fails", async () => {
  const ops = operations();
  mocks.bulk.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  await mount(<CommentCreate workspaceSlug="lab" projectId="project" entityId="issue" activityOperations={ops} />);
  await attach();
  await click("图片");
  await click("评论");
  expect(ops.createComment).toHaveBeenCalledWith(
    expect.objectContaining({
      comment_html: '<p><image-component src="image"></image-component></p>',
      attachment_ids: ["asset"],
    })
  );
  expect(mocks.bulk).toHaveBeenCalledWith("lab", "project", "comment", { asset_ids: ["image"] });
  await click("评论");
  expect(ops.createComment).toHaveBeenCalledOnce();
  expect(ops.updateComment).toHaveBeenCalledWith("comment", expect.objectContaining({ attachment_ids: ["asset"] }));
});

it("keeps editing on failure and applies attachment changes only after save", async () => {
  const ops = operations();
  vi.mocked(ops.updateComment).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
  const setEditing = vi.fn();
  const comment = { id: "comment", comment_html: "<p></p>", file_attachments: [] } as unknown as TIssueComment;
  await mount(
    <CommentCardEditForm
      workspaceSlug="lab"
      workspaceId="ws"
      projectId="project"
      comment={comment}
      activityOperations={ops}
      isEditing
      readOnlyEditorRef={null}
      setIsEditing={setEditing}
    />
  );
  await attach();
  await click("保存评论");
  expect(setEditing).not.toHaveBeenCalled();
  expect(container.textContent).toContain("已保留");
  await click("保存评论");
  expect(setEditing).toHaveBeenCalledWith(false);
  expect(ops.updateComment).toHaveBeenLastCalledWith("comment", { comment_html: "<p></p>", attachment_ids: ["asset"] });
});

it("does not submit while an image placeholder is still pending", async () => {
  const ops = operations();
  await mount(<CommentCreate workspaceSlug="lab" projectId="project" entityId="issue" activityOperations={ops} />);
  await click("未完成图片");
  await act(async () => {
    container
      .querySelector<HTMLTextAreaElement>('textarea[aria-label="评论正文"]')
      ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
  });
  expect(ops.createComment).not.toHaveBeenCalled();
});
