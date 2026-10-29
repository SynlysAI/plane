/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { EIssueServiceType } from "@plane/types";
import { IssueAttachmentActionButton } from "../issue-detail-widgets/attachments/quick-action-button";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// hooks
import { useAttachmentOperations } from "../issue-detail-widgets/attachments/helper";
// components
import { IssueAttachmentsList } from "./attachments-list";
import { IssueAttachmentDropZone } from "./attachment-drop-zone";

export type TIssueAttachmentRoot = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  disabled?: boolean;
};

export const IssueAttachmentRoot = observer(function IssueAttachmentRoot(props: TIssueAttachmentRoot) {
  // props
  const { workspaceSlug, projectId, issueId, disabled = false } = props;
  const { t } = useTranslation();
  // hooks
  const attachmentHelpers = useAttachmentOperations(workspaceSlug, projectId, issueId);
  const {
    attachment: { getAttachmentsByIssueId },
  } = useIssueDetail();
  const hasContent = Boolean(
    attachmentHelpers.snapshot.uploadStatus?.length || getAttachmentsByIssueId(issueId)?.length
  );

  return (
    <div className="relative space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-body-sm-medium">{t("common.attachments")}</h3>
        {!disabled && (
          <IssueAttachmentActionButton
            workspaceSlug={workspaceSlug}
            projectId={projectId}
            issueId={issueId}
            disabled={disabled}
            issueServiceType={EIssueServiceType.ISSUES}
          />
        )}
      </div>
      <IssueAttachmentDropZone
        workspaceSlug={workspaceSlug}
        projectId={projectId}
        issueId={issueId}
        attachmentHelpers={attachmentHelpers}
        hasContent={hasContent}
        disabled={disabled}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          <IssueAttachmentsList issueId={issueId} disabled={disabled} attachmentHelpers={attachmentHelpers} />
        </div>
      </IssueAttachmentDropZone>
    </div>
  );
});
