/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useState, type ReactNode } from "react";
import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import type { TIssueServiceType } from "@plane/types";
import { EIssueServiceType } from "@plane/types";
import { AttachmentUploadZone } from "@/components/attachments/upload-zone";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import type { TAttachmentHelpers } from "../issue-detail-widgets/attachments/helper";

type Props = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  attachmentHelpers: TAttachmentHelpers;
  disabled?: boolean;
  issueServiceType?: TIssueServiceType;
  hasContent: boolean;
  children: ReactNode;
};

/** Wrap an issue's attachment content in the shared drag-only upload surface. */
export const IssueAttachmentDropZone = observer(function IssueAttachmentDropZone(props: Props) {
  const {
    workspaceSlug,
    projectId,
    issueId,
    attachmentHelpers,
    disabled = false,
    issueServiceType = EIssueServiceType.ISSUES,
    hasContent,
    children,
  } = props;
  const { t } = useTranslation();
  const [isUploading, setIsUploading] = useState(false);
  const { fetchActivities, setLastWidgetAction } = useIssueDetail(issueServiceType);

  const handleFiles = useCallback(
    async (files: File[]) => {
      setIsUploading(true);
      try {
        await attachmentHelpers.operations.createMany(files);
      } catch {
        // The shared attachment operation owns upload error notifications.
      } finally {
        if (files.length > 0) {
          fetchActivities(workspaceSlug, projectId, issueId);
          setLastWidgetAction("attachments");
        }
        setIsUploading(false);
      }
    },
    [attachmentHelpers.operations, fetchActivities, issueId, projectId, setLastWidgetAction, workspaceSlug]
  );

  return (
    <AttachmentUploadZone
      onFiles={handleFiles}
      multiple
      clickToSelect={false}
      showPrompt={!hasContent}
      title={t("attachment.drag_and_drop")}
      activeTitle={t("attachment.upload_zone.active")}
      inputAriaLabel={t("attachment.create.title")}
      disabled={disabled}
      uploading={isUploading}
      minSize={0}
      variant="block"
      className={
        hasContent
          ? "min-h-0 items-stretch justify-start rounded-sm border-0 bg-transparent p-0 text-left hover:bg-transparent"
          : ""
      }
    >
      {children}
    </AttachmentUploadZone>
  );
});
