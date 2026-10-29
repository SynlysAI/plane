/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useState } from "react";
import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { MAX_FILE_ATTACHMENTS } from "@plane/constants";
import { AttachmentUploadZone } from "@/components/attachments/upload-zone";
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
  const { isLoading: limitsLoading, getLimitError } = useIssueAttachmentLimits(workspaceSlug, projectId);

  const handleFiles = useCallback(
    (acceptedFiles: File[]) => {
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

  return (
    <AttachmentUploadZone
      error={validationError}
      onFiles={handleFiles}
      multiple
      disabled={disabled || limitsLoading}
      uploading={isLoading}
      variant="block"
      className="h-[60px]"
    />
  );
});
