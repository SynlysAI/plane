/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { Button } from "@plane/propel/button";
// components
import { getResearchErrorKey } from "@/components/research/common/error-messages";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
  reportId: string;
  editable: boolean;
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const attachments = research.reportAttachments[reportId] ?? [];

  useEffect(() => {
    void research.fetchReportAttachments(workspaceSlug, reportId).catch((error) => {
      setErrorKey(getResearchErrorKey(error));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, reportId]);

  const handleUpload = useCallback(
    async (file: File) => {
      try {
        await research.uploadReportAttachment(workspaceSlug, reportId, {
          file_name: file.name,
          content_type: file.type || "application/octet-stream",
          size: file.size,
          body: file,
        });
        setErrorKey(null);
      } catch (error) {
        setErrorKey(getResearchErrorKey(error));
      }
    },
    [reportId, research, workspaceSlug]
  );

  const handleDelete = useCallback(
    async (attachmentId: string) => {
      try {
        await research.deleteReportAttachment(workspaceSlug, reportId, attachmentId);
        setErrorKey(null);
      } catch (error) {
        setErrorKey(getResearchErrorKey(error));
      }
    },
    [reportId, research, workspaceSlug]
  );

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-subtle bg-surface-1 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-13 font-medium text-primary">{t("research.attachments.title")}</h3>
        {editable && (
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
              {t("research.attachments.upload_file")}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.tsv,image/*,application/pdf"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleUpload(file);
                event.target.value = "";
              }}
            />
          </div>
        )}
      </div>

      {errorKey && (
        <div className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
          {t(errorKey)}
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
                <TableCell className="text-secondary">{attachment.file_name}</TableCell>
                <TableCell className="text-tertiary">{attachment.kind}</TableCell>
                <TableCell className="text-tertiary">{Math.round(attachment.file_size / 1024)} KB</TableCell>
                <TableCell>{attachment.uploaded_by}</TableCell>
                <TableCell className="text-right">
                  <a
                    className="mr-3 text-accent-primary"
                    href={`/api/research/workspaces/${workspaceSlug}/reports/${reportId}/attachments/${attachment.id}/`}
                  >
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
