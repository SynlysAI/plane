/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import type { TIssueServiceType } from "@plane/types";
import { EIssueServiceType } from "@plane/types";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// types
import type { TAttachmentHelpers } from "../issue-detail-widgets/attachments/helper";
// components
import { IssueAttachmentsListItem } from "./attachment-list-item";
import { IssueAttachmentsUploadItem } from "./attachment-list-upload-item";
import { IssueAttachmentDropZone } from "./attachment-drop-zone";
// types
import { IssueAttachmentDeleteModal } from "./delete-attachment-modal";

type TIssueAttachmentItemList = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  attachmentHelpers: TAttachmentHelpers;
  disabled?: boolean;
  issueServiceType?: TIssueServiceType;
};

export const IssueAttachmentItemList = observer(function IssueAttachmentItemList(props: TIssueAttachmentItemList) {
  const {
    workspaceSlug,
    projectId,
    issueId,
    attachmentHelpers,
    disabled,
    issueServiceType = EIssueServiceType.ISSUES,
  } = props;
  // store hooks
  const {
    attachment: { getAttachmentsByIssueId },
    attachmentDeleteModalId,
    toggleDeleteAttachmentModal,
  } = useIssueDetail(issueServiceType);
  const { operations: attachmentOperations, snapshot: attachmentSnapshot } = attachmentHelpers;
  const { uploadStatus } = attachmentSnapshot;
  // derived values
  const issueAttachments = getAttachmentsByIssueId(issueId);
  const hasContent = Boolean(uploadStatus?.length || issueAttachments?.length);

  return (
    <>
      {uploadStatus?.map((currentUploadStatus) => (
        <IssueAttachmentsUploadItem key={currentUploadStatus.id} uploadStatus={currentUploadStatus} />
      ))}
      {attachmentDeleteModalId && (
        <IssueAttachmentDeleteModal
          isOpen={Boolean(attachmentDeleteModalId)}
          onClose={() => toggleDeleteAttachmentModal(null)}
          attachmentOperations={attachmentOperations}
          attachmentId={attachmentDeleteModalId}
          issueServiceType={issueServiceType}
        />
      )}
      <IssueAttachmentDropZone
        workspaceSlug={workspaceSlug}
        projectId={projectId}
        issueId={issueId}
        issueServiceType={issueServiceType}
        attachmentHelpers={attachmentHelpers}
        hasContent={hasContent}
        disabled={disabled}
      >
        <div className="relative flex flex-col">
          {issueAttachments?.map((attachmentId) => (
            <IssueAttachmentsListItem
              key={attachmentId}
              attachmentId={attachmentId}
              disabled={disabled}
              issueServiceType={issueServiceType}
            />
          ))}
        </div>
      </IssueAttachmentDropZone>
    </>
  );
});
