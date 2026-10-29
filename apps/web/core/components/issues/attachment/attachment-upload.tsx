/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useState } from "react";
import { observer } from "mobx-react";
import type { FileRejection } from "react-dropzone";
import { useDropzone } from "react-dropzone";
import { useTranslation } from "@plane/i18n";
import { MAX_FILE_ATTACHMENTS } from "@plane/constants";
// plane web hooks
import { useIssueAttachmentLimits } from "@/hooks/use-issue-attachment-limits";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// types
import type { TAttachmentOperations } from "../issue-detail-widgets/attachments/helper";

type TAttachmentOperationsModal = Pick<TAttachmentOperations, "createMany">;

type Props = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  disabled?: boolean;
  attachmentOperations: TAttachmentOperationsModal;
};

export const IssueAttachmentUpload = observer(function IssueAttachmentUpload(props: Props) {
  const { workspaceSlug, projectId, issueId, disabled = false, attachmentOperations } = props;
  const { t } = useTranslation();
  // states
  const [isLoading, setIsLoading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const {
    attachment: { getAttachmentsByIssueId },
  } = useIssueDetail();
  // file size categories
  const { isLoading: limitsLoading, maxFileSize, getLimitError } = useIssueAttachmentLimits(workspaceSlug, projectId);

  const onDrop = useCallback(
    (acceptedFiles: File[], rejectedFiles: FileRejection[]) => {
      if (rejectedFiles.length > 0) {
        setValidationError(null);
        return;
      }
      if (acceptedFiles.length === 0 || !workspaceSlug) return;

      const attachmentCount = getAttachmentsByIssueId(issueId)?.length ?? 0;
      if (attachmentCount + acceptedFiles.length > MAX_FILE_ATTACHMENTS) {
        setValidationError(t("attachment.count_limit", { count: MAX_FILE_ATTACHMENTS }));
        return;
      }

      const limitError = acceptedFiles.map((file) => getLimitError(file)).find(Boolean);
      if (limitError) {
        setValidationError(limitError);
        return;
      }
      setValidationError(null);
      setIsLoading(true);
      attachmentOperations.createMany(acceptedFiles).finally(() => setIsLoading(false));
    },
    [attachmentOperations, getAttachmentsByIssueId, getLimitError, issueId, t, workspaceSlug]
  );

  const { getRootProps, getInputProps, isDragActive, isDragReject, fileRejections } = useDropzone({
    onDrop,
    maxSize: maxFileSize,
    multiple: true,
    disabled: limitsLoading || isLoading || disabled,
  });

  const rejectedError = fileRejections.length > 0 ? getLimitError(fileRejections[0].file) : null;
  const fileError = validationError ?? rejectedError;

  return (
    <div
      {...getRootProps()}
      className={`flex h-[60px] items-center justify-center rounded-md border-2 border-dashed bg-accent-primary/5 px-4 text-11 text-accent-primary ${
        isDragActive ? "border-accent-strong bg-accent-primary/10" : "border-subtle"
      } ${isDragReject ? "bg-danger-subtle" : ""} ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
    >
      <input {...getInputProps()} />
      <span className="flex items-center gap-2">
        {isDragActive ? (
          <p>Drop here...</p>
        ) : fileError ? (
          <p className="text-center text-danger-primary">{fileError}</p>
        ) : isLoading ? (
          <p className="text-center">Uploading...</p>
        ) : (
          <p className="text-center">Click or drag files or folders here</p>
        )}
      </span>
    </div>
  );
});
