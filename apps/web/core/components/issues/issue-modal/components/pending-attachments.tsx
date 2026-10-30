/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect } from "react";
import { observer } from "mobx-react";
import { CloseOutline } from "@makeplane/propel/icons";
// plane imports
import { useTranslation } from "@plane/i18n";
import { MAX_FILE_ATTACHMENTS } from "@plane/constants";
import { cn } from "@plane/utils";
// hooks
import { useIssueAttachmentLimits, type TIssueAttachmentLimitsState } from "@/hooks/use-issue-attachment-limits";

export type TIssuePendingAttachment = {
  id: string;
  file: File;
};

type Props = {
  attachments: TIssuePendingAttachment[];
  onRemove: (attachmentId: string) => void;
  onValidationChange: (error: string | null) => void;
  workspaceSlug: string;
  projectId: string;
  disabled?: boolean;
  limitsState?: TIssueAttachmentLimitsState;
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

type ViewProps = Omit<Props, "limitsState"> & {
  getLimitError: (file: File) => string | null;
};

/** 渲染暂存附件队列，并向上同步可保存状态。 */
function IssuePendingAttachmentsView(props: ViewProps) {
  const { attachments, onRemove, onValidationChange, disabled = false, getLimitError } = props;
  const { t } = useTranslation();

  const getQueueError = useCallback(() => {
    if (attachments.length > MAX_FILE_ATTACHMENTS) {
      return t("attachment.count_limit", { count: MAX_FILE_ATTACHMENTS });
    }
    return attachments.map((attachment) => getLimitError(attachment.file)).find(Boolean) ?? null;
  }, [attachments, getLimitError, t]);

  useEffect(() => {
    onValidationChange(getQueueError());
  }, [getQueueError, onValidationChange]);

  const queueError = getQueueError();
  if (attachments.length === 0 && !queueError) return null;

  return (
    <section aria-label={t("attachment.create.title")} className="pt-3">
      {queueError && (
        <p role="alert" className="pb-2 text-caption-sm-regular text-danger-primary">
          {queueError}
        </p>
      )}
      {attachments.length > 0 && (
        <ul className="divide-y divide-subtle overflow-hidden rounded-md border border-subtle bg-surface-2">
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
}

/** 未由创建表单预取额度时，组件自行读取项目级额度。 */
const IssuePendingAttachmentsWithLimits = observer(function IssuePendingAttachmentsWithLimits(
  props: Omit<Props, "limitsState">
) {
  const { getLimitError } = useIssueAttachmentLimits(props.workspaceSlug, props.projectId);
  return <IssuePendingAttachmentsView {...props} getLimitError={getLimitError} />;
});

export const IssuePendingAttachments = observer(function IssuePendingAttachments(props: Props) {
  if (props.limitsState) {
    return <IssuePendingAttachmentsView {...props} getLimitError={props.limitsState.getLimitError} />;
  }
  const { limitsState: _limitsState, ...fallbackProps } = props;
  return <IssuePendingAttachmentsWithLimits {...fallbackProps} />;
});
