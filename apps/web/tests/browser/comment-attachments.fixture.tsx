import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { TranslationProvider, setLanguage } from "@plane/i18n";
import type { TCommentsOperations, TIssueComment } from "@plane/types";
import { CommentCreate } from "@/components/comments/comment-create";
import { CommentCard } from "@/components/comments/card/root";
import { CommentCardEditForm } from "@/components/comments/card/edit-form";
import { StoreProvider, store } from "@/lib/store-context";
import { FileService } from "@/services/file.service";
// oxlint-disable-next-line import/no-unassigned-import -- 验收沿用应用真实样式。
import "../../styles/globals.css";

const STORAGE_KEY = "comment-attachment-browser-fixture";
store.workspaceRoot.workspaces.workspace = { id: "workspace", slug: "lab", name: "公共工作区" } as never;
// 真实组件、编辑器和草稿逻辑；仅持久化边界替换为浏览器本地存储。
FileService.prototype.checkIfAssetExists = async () => ({ exists: true });

/** 运行可刷新保留评论的浏览器验收工作台。 */
function Fixture() {
  const [comments, setComments] = useState<TIssueComment[]>(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]"));
  const [failure, setFailure] = useState(false);
  const [editing, setEditing] = useState(false);

  /** 写入演示评论，模拟后端完整响应。 */
  function persist(next: TIssueComment[]) {
    setComments(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  const operations = {
    createComment: async (data) => {
      if (failure) throw new Error("模拟网络失败");
      const comment = {
        ...data,
        id: crypto.randomUUID(),
        workspace: "workspace",
        project: "project",
        issue: "issue",
        actor: "author",
        actor_detail: { display_name: "项目成员" },
        created_by: "author",
        created_at: new Date().toISOString(),
        comment_reactions: [],
        file_attachments: (data.attachment_ids ?? []).map((id) => JSON.parse(localStorage.getItem(id)!)),
      } as TIssueComment;
      persist([...comments, comment]);
      return comment;
    },
    updateComment: async (id, data) => {
      if (failure) throw new Error("模拟网络失败");
      persist(
        comments.map((comment) =>
          comment.id === id
            ? {
                ...comment,
                ...data,
                edited_at: new Date().toISOString(),
                file_attachments: (data.attachment_ids ?? comment.file_attachments?.map((file) => file.id) ?? []).map(
                  (assetId) => JSON.parse(localStorage.getItem(assetId)!)
                ),
              }
            : comment
        )
      );
    },
    removeComment: async (id) => persist(comments.filter((comment) => comment.id !== id)),
    uploadCommentAttachment: async (file) => {
      if (file.name.includes("fail")) throw new Error("模拟上传失败");
      const id = crypto.randomUUID();
      const content = new Uint8Array(await file.arrayBuffer());
      const attachment = {
        id,
        name: file.name,
        type: file.type,
        size: file.size,
        download_url: `data:application/octet-stream;base64,${btoa(String.fromCharCode(...content))}`,
      };
      localStorage.setItem(id, JSON.stringify(attachment));
      return attachment;
    },
    discardCommentAttachment: async (id) => {
      localStorage.removeItem(id);
    },
    userReactions: () => [],
    reactionIds: () => ({}),
    getReactionUsers: () => "",
    react: async () => {},
    uploadCommentAsset: async () => ({ asset_id: "image" }),
    duplicateCommentAsset: async () => ({ asset_id: "image" }),
  } as TCommentsOperations;

  return (
    <main className="mx-auto min-h-screen max-w-4xl bg-surface-1 p-5 text-primary sm:p-8">
      <div className="mb-6 border-b border-subtle pb-4">
        <p className="mb-2 text-12 text-tertiary">行政项目 / 报告材料</p>
        <h1 className="text-22 font-semibold">过程材料整理</h1>
        <p className="mt-2 text-13 text-secondary">状态：已完成 · 完成后仍可补充过程文件</p>
      </div>
      <div className="mb-4 flex gap-4 text-12 text-secondary">
        <label>
          <input type="checkbox" checked={failure} onChange={(event) => setFailure(event.target.checked)} />{" "}
          模拟提交失败
        </label>
        <button
          onClick={() => {
            localStorage.clear();
            persist([]);
          }}
        >
          清空验收数据
        </button>
      </div>
      <h2 className="mb-3 text-16 font-semibold">活动</h2>
      {comments.map((comment) => (
        <div key={comment.id}>
          <CommentCard
            comment={comment}
            activityOperations={operations}
            workspaceSlug="lab"
            entityId="issue"
            projectId="project"
            ends="bottom"
            showAccessSpecifier={false}
            showCopyLinkOption={false}
            enableReplies={false}
            disabled
          />
          <button className="mb-3 text-12 text-secondary" onClick={() => setEditing(!editing)}>
            编辑附件验收
          </button>
          {editing && <EditFixture comment={comment} operations={operations} close={() => setEditing(false)} />}
        </div>
      ))}
      <CommentCreate
        workspaceSlug="lab"
        entityId="issue"
        projectId="project"
        activityOperations={operations}
        showToolbarInitially
      />
    </main>
  );
}

/** 直接暴露编辑表单，避免验收依赖登录用户操作菜单。 */
function EditFixture({
  comment,
  operations,
  close,
}: {
  comment: TIssueComment;
  operations: TCommentsOperations;
  close: () => void;
}) {
  return (
    <CommentCardEditForm
      comment={comment}
      activityOperations={operations}
      workspaceSlug="lab"
      workspaceId="workspace"
      projectId="project"
      readOnlyEditorRef={null}
      isEditing
      setIsEditing={close}
    />
  );
}

await setLanguage("zh-CN");
document.documentElement.dataset.theme = "light";
createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <TranslationProvider>
      <MemoryRouter initialEntries={["/lab/projects/project/issues/issue"]}>
        <Fixture />
      </MemoryRouter>
    </TranslationProvider>
  </StoreProvider>
);
