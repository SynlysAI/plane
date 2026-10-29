import React, { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useForm } from "react-hook-form";
import { MemoryRouter } from "react-router";
import { setLanguage, TranslationProvider } from "@plane/i18n";
import type { EditorRefApi } from "@plane/editor";
import type { TIssue } from "@plane/types";
import { IssueAttachmentDropZone } from "@/components/issues/attachment/attachment-drop-zone";
import type { TAttachmentHelpers } from "@/components/issues/issue-detail-widgets/attachments/helper";
import { IssueDescriptionEditor } from "@/components/issues/issue-modal/components/description-editor";
import { IssuePendingAttachments } from "@/components/issues/issue-modal/components/pending-attachments";
import { StoreProvider, store } from "@/lib/store-context";
import { FileService } from "@/services/file.service";
// oxlint-disable-next-line import/no-unassigned-import -- 验收沿用应用真实样式。
import "../../styles/globals.css";

const LIMITS = {
  image: { max_mb: 20, max_bytes: 20 * 1024 * 1024 },
  pdf: { max_mb: 100, max_bytes: 100 * 1024 * 1024 },
  markdown: { max_mb: 5, max_bytes: 5 * 1024 * 1024 },
  office: { max_mb: 50, max_bytes: 50 * 1024 * 1024 },
};

store.workspaceRoot.workspaces.workspace = { id: "workspace", slug: "lab", name: "公共工作区" } as never;
store.issue.issueDetail.fetchActivities = async () => [];
FileService.prototype.getCommentAttachmentLimits = async () => LIMITS;

/** 展示新建工作项说明队列与已存在工作项附件区的上传反馈。 */
function Fixture() {
  const { control } = useForm<TIssue>({ defaultValues: { description_html: "<p>填写行政工作项说明。</p>" } as TIssue });
  const editorRef = useRef<EditorRefApi | null>(null);
  const submitBtnRef = useRef<HTMLButtonElement | null>(null);
  const [description, setDescription] = useState("<p>填写行政工作项说明。</p>");
  const [pendingAttachments, setPendingAttachments] = useState<{ id: string; file: File }[]>([]);
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([]);

  const attachmentHelpers = useMemo<TAttachmentHelpers>(
    () => ({
      operations: {
        create: async (file) => {
          setUploadedFiles((current) => [...current, { id: crypto.randomUUID(), file }]);
        },
        createMany: async (files) => {
          setUploadedFiles((current) => [...current, ...files.map((file) => ({ id: crypto.randomUUID(), file }))]);
        },
        remove: async () => undefined,
      },
      snapshot: { uploadStatus: [] },
    }),
    []
  );

  return (
    <main className="bg-background mx-auto min-h-screen max-w-4xl space-y-6 p-5 text-primary sm:p-8">
      <header className="border-b border-subtle pb-4">
        <p className="text-12 text-tertiary">行政项目 / 新建工作项</p>
        <h1 className="text-22 mt-1 font-semibold">整理采购流程材料</h1>
      </header>

      <section aria-labelledby="description-title" className="space-y-3">
        <h2 id="description-title" className="text-16 font-semibold">
          说明
        </h2>
        <IssueDescriptionEditor
          control={control}
          isDraft
          issueName="整理采购流程材料"
          issueId={undefined}
          descriptionHtmlData={description}
          editorRef={editorRef}
          submitBtnRef={submitBtnRef}
          gptAssistantModal={false}
          workspaceSlug="lab"
          projectId="project"
          handleFormChange={() => undefined}
          handleDescriptionHTMLDataChange={setDescription}
          setGptAssistantModal={() => undefined}
          handleGptAssistantClose={() => undefined}
          onAssetUpload={() => undefined}
          onAttachFiles={(files) =>
            setPendingAttachments((current) => [
              ...current,
              ...files.map((file) => ({ id: crypto.randomUUID(), file })),
            ])
          }
          attachmentContent={
            <IssuePendingAttachments
              attachments={pendingAttachments}
              onRemove={(id) => setPendingAttachments((current) => current.filter((item) => item.id !== id))}
              onValidationChange={() => undefined}
              workspaceSlug="lab"
              projectId="project"
            />
          }
          onClose={() => undefined}
        />
        <button ref={submitBtnRef} type="button" className="sr-only">
          保存工作项
        </button>
      </section>

      <section aria-labelledby="attachments-title" className="space-y-3 border-t border-subtle pt-5">
        <h2 id="attachments-title" className="text-16 font-semibold">
          Attachments
        </h2>
        <IssueAttachmentDropZone
          workspaceSlug="lab"
          projectId="project"
          issueId="issue"
          attachmentHelpers={attachmentHelpers}
          hasContent={uploadedFiles.length > 0}
        >
          {uploadedFiles.length > 0 && (
            <ul className="divide-y divide-subtle">
              {uploadedFiles.map(({ id, file }) => (
                <li key={id} className="py-2 text-13 text-secondary">
                  {file.name}
                </li>
              ))}
            </ul>
          )}
        </IssueAttachmentDropZone>
      </section>
    </main>
  );
}

void setLanguage("zh-CN");
createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <TranslationProvider>
      <MemoryRouter initialEntries={["/lab/projects/project/issues/new"]}>
        <Fixture />
      </MemoryRouter>
    </TranslationProvider>
  </StoreProvider>
);
