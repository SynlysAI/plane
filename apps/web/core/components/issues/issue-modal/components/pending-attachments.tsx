/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
import { CloseOutline } from "@makeplane/propel/icons";
// plane imports
import { useTranslation } from "@plane/i18n";
import { MAX_FILE_ATTACHMENTS } from "@plane/constants";
import { cn } from "@plane/utils";
// components
import { AttachmentUploadZone } from "@/components/attachments/upload-zone";
// hooks
import { useIssueAttachmentLimits } from "@/hooks/use-issue-attachment-limits";

export type TIssuePendingAttachment = {
  id: string;
  file: File;
};

type Props = {
  attachments: TIssuePendingAttachment[];
  onAdd: (files: File[]) => void;
  onRemove: (attachmentId: string) => void;
  onValidationChange: (error: string | null) => void;
  workspaceSlug: string;
  projectId: string;
  disabled?: boolean;
};

type TUploadPendingIssueAttachmentsArgs = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  pendingAttachments: TIssuePendingAttachment[];
  createAttachment: (workspaceSlug: string, projectId: string, issueId: string, file: File) => Promise<unknown>;
};

/** 将浏览器文件大小格式化为紧凑的可读文本。 */
function formatFileSize(size: number) {
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return "1 KB";
}

/** 顺序上传暂存附件，并返回上传失败的文件名列表。 */
export async function uploadPendingIssueAttachments(args: TUploadPendingIssueAttachmentsArgs) {
  const { createAttachment, issueId, pendingAttachments, projectId, workspaceSlug } = args;
  const failedNames: string[] = [];

  /* eslint-disable no-await-in-loop -- 顺序上传可让附件计数与失败队列保持确定性。 */
  for (const attachment of pendingAttachments) {
    try {
      await createAttachment(workspaceSlug, projectId, issueId, attachment.file);
    } catch (error) {
      console.error(`Error in uploading work item attachment ${attachment.file.name}:`, error);
      failedNames.push(attachment.file.name);
    }
  }
  /* eslint-enable no-await-in-loop */

  return failedNames;
}

export const IssuePendingAttachments = observer(function IssuePendingAttachments(props: Props) {
  const { attachments, onAdd, onRemove, onValidationChange, workspaceSlug, projectId, disabled = false } = props;
  const { t } = useTranslation();
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const { isLoading: limitsLoading, maxFileSize, getLimitError } = useIssueAttachmentLimits(workspaceSlug, projectId);

  const getQueueError = useCallback(() => {
    if (attachments.length > MAX_FILE_ATTACHMENTS) {
      return t("attachment.count_limit", { count: MAX_FILE_ATTACHMENTS });
    }
    return attachments.map((attachment) => getLimitError(attachment.file)).find(Boolean) ?? null;
  }, [attachments, getLimitError, t]);

  useEffect(() => {
    onValidationChange(getQueueError());
  }, [getQueueError, onValidationChange]);

  const handleFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      if (attachments.length + files.length > MAX_FILE_ATTACHMENTS) {
        setSelectionError(t("attachment.count_limit", { count: MAX_FILE_ATTACHMENTS }));
        return;
      }

      const limitError = files.map((file) => getLimitError(file)).find(Boolean);
      if (limitError) {
        setSelectionError(limitError);
        return;
      }

      setSelectionError(null);
      onAdd(files);
    },
    [attachments.length, getLimitError, onAdd, t]
  );

  return (
    <section className="rounded-lg border border-subtle bg-surface-1 px-4 pt-3 pb-3">
      <div className="flex items-baseline justify-between gap-3 pb-2">
        <h4 className="text-caption-medium text-secondary">{t("attachment.create.title")}</h4>
        <span className="text-caption-sm-regular text-tertiary">{t("attachment.create.hint")}</span>
      </div>
      <AttachmentUploadZone
        error={selectionError}
        onFiles={handleFiles}
        multiple
        maxSize={maxFileSize}
        disabled={disabled || limitsLoading}
        title={t("attachment.create.zone_title")}
        activeTitle={t("attachment.upload_zone.active")}
        variant="compact"
      />
      {attachments.length > 0 && (
        <ul className="mt-2 divide-y divide-subtle overflow-hidden rounded-md border border-subtle bg-surface-2">
          {attachments.map((attachment) => (
            <li key={attachment.id} className="flex min-h-9 items-center gap-3 px-3 py-1.5">
              <span
                className="min-w-0 flex-1 truncate text-caption-sm-regular text-primary"
                title={attachment.file.name}
              >
                {attachment.file.name}
              </span>
              <span className="shrink-0 text-caption-sm-regular text-tertiary">
                {formatFileSize(attachment.file.size)}
              </span>
              <button
                type="button"
                className={cn(
                  "flex size-6 items-center justify-center rounded-md text-tertiary transition-colors",
                  "hover:bg-surface-hover focus-visible:ring-border-strong hover:text-secondary focus-visible:ring-1 focus-visible:outline-none"
                )}
                onClick={() => onRemove(attachment.id)}
                aria-label={t("attachment.create.remove", { name: attachment.file.name })}
                disabled={disabled}
              >
                <CloseOutline className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
});
