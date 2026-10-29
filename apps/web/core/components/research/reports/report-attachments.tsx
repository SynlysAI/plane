/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
// components
import { AttachmentPreviewLink } from "@/components/attachments/preview";
import { AttachmentUploadZone } from "@/components/attachments/upload-zone";
import { getResearchErrorDetail, getResearchErrorKey } from "@/components/research/common/error-messages";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
  reportId: string;
  editable: boolean;
};

const REPORT_ATTACHMENT_ACCEPT = {
  "application/pdf": [".pdf"],
  "text/markdown": [".md", ".markdown"],
  "text/plain": [".txt", ".csv", ".tsv"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.ms-excel": [".xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.ms-powerpoint": [".ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
  "image/*": [],
};

/**
 * Attachments and Markdown body import for a report (P0-FILE-01 ~
 * P0-FILE-07). Uploads go straight to S3 through a presigned POST so the
 * server never buffers the file.
 */
export const ResearchReportAttachments = observer(function ResearchReportAttachments({
  workspaceSlug,
  reportId,
  editable,
}: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const [attachmentError, setError] = useState<unknown>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const attachments = research.reportAttachments[reportId] ?? [];

  useEffect(() => {
    void research.fetchReportAttachments(workspaceSlug, reportId).catch((error) => {
      setError(error);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, reportId]);

  const handleUpload = useCallback(
    async (files: File[]) => {
      const failedFiles: string[] = [];
      setUploadError(null);
      setIsUploading(true);
      try {
        /* eslint-disable no-await-in-loop -- Preserve the batch order and continue after individual failures. */
        for (const file of files) {
          try {
            await research.uploadReportAttachment(workspaceSlug, reportId, {
              file_name: file.name,
              content_type: file.type || "application/octet-stream",
              size: file.size,
              body: file,
            });
          } catch {
            failedFiles.push(file.name);
          }
        }
        /* eslint-enable no-await-in-loop */
        if (failedFiles.length > 0) {
          setUploadError(
            failedFiles.length === files.length
              ? `${files.length} 个附件上传失败，请重试。`
              : `${failedFiles.length} 个附件上传失败，其余 ${files.length - failedFiles.length} 个已上传。`
          );
        }
        setError(null);
      } finally {
        setIsUploading(false);
      }
    },
    [reportId, research, workspaceSlug]
  );

  const handleDelete = useCallback(
    async (attachmentId: string) => {
      try {
        await research.deleteReportAttachment(workspaceSlug, reportId, attachmentId);
        setError(null);
      } catch (error) {
        setError(error);
      }
    },
    [reportId, research, workspaceSlug]
  );

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-subtle bg-surface-1 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-13 font-semibold text-primary">{t("research.attachments.title")}</h3>
      </div>

      {editable && (
        <AttachmentUploadZone
          onFiles={handleUpload}
          accept={REPORT_ATTACHMENT_ACCEPT}
          multiple
          uploading={isUploading}
          error={uploadError}
          title={t("research.attachments.upload_file")}
          hint="支持一次选择或拖拽多个文件和文件夹"
        />
      )}

      {attachmentError !== null && (
        <div className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
          <div>{t(getResearchErrorKey(attachmentError))}</div>
          {getResearchErrorDetail(attachmentError) && (
            <div className="mt-1 text-11 break-words text-danger-primary/80">
              {getResearchErrorDetail(attachmentError)}
            </div>
          )}
        </div>
      )}
      <p className="text-12 text-tertiary">
        附件尚未进行病毒扫描；Office/PDF 尚未解析，二进制内容不会作为正文送入 Agent。
      </p>
      <div className="max-w-full overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="text-tertiary">
              <TableHead>{t("research.attachments.columns.name")}</TableHead>
              <TableHead>{t("research.attachments.columns.kind")}</TableHead>
              <TableHead>{t("research.attachments.columns.size")}</TableHead>
              <TableHead>上传者</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {attachments.map((attachment) => (
              <TableRow key={attachment.id}>
                <TableCell className="text-secondary">
                  <AttachmentPreviewLink
                    name={attachment.file_name}
                    previewUrl={attachment.preview_url}
                    downloadUrl={attachment.asset_url ?? ""}
                    className="max-w-xs truncate text-left hover:underline"
                  />
                </TableCell>
                <TableCell className="text-tertiary">{attachment.kind}</TableCell>
                <TableCell className="text-tertiary">{Math.round(attachment.file_size / 1024)} KB</TableCell>
                <TableCell>{attachment.uploaded_by}</TableCell>
                <TableCell className="text-right">
                  <a className="mr-3 text-accent-primary" href={attachment.asset_url}>
                    {t("research.attachments.download")}
                  </a>
                  {editable && (
                    <Button variant="ghost" size="sm" onClick={() => void handleDelete(attachment.id)}>
                      {t("research.common.delete")}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {attachments.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-tertiary">
                  {t("research.attachments.empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
});
