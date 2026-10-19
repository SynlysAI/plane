// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { TCommentsOperations, TIssueComment } from "@plane/types";

const mocks = vi.hoisted(() => ({ bulk: vi.fn(), uploadImage: vi.fn() }));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => ({ getWorkspaceBySlug: () => ({ id: "ws" }) }) }));
vi.mock("@/hooks/use-file-size", () => ({ useFileSize: () => ({ maxFileSize: 1024 }) }));
vi.mock("@/services/file.service", () => ({
  FileService: class {
    updateBulkProjectAssetsUploadStatus = mocks.bulk;
  },
}));
vi.mock("@/components/editor/lite-text", () => ({
  LiteTextEditor: React.forwardRef(function Editor(props: any, ref) {
    const [body, setBody] = React.useState(props.initialValue);
    React.useImperativeHandle(ref, () => ({
      isEditorReadyToDiscard: () => true,
      clearEditor: () => setBody("<p></p>"),
      setEditorValue: setBody,
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
        <button onClick={() => props.uploadFile("block", new File(["image"], "image.png"))}>图片</button>
        {props.attachmentContent}
        {props.showSubmitButton !== false && (
          <button
            disabled={
              props.isSubmitting ||
              props.isSubmitDisabled ||
              (!props.hasAttachments && props.initialValue === "<p></p>")
            }
            onClick={props.onEnterKeyPress}
          >
            评论
          </button>
        )}
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
}

/** 通过原生文件事件添加过程文件。 */
async function attach() {
  await act(async () => {
    const input = container.querySelector('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["pptx"], "过程.pptx")] });
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
