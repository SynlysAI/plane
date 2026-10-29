/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useMemo } from "react";
import { setPromiseToast, TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { TIssueServiceType } from "@plane/types";
import { EIssueServiceType } from "@plane/types";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// types
import type { TAttachmentUploadStatus } from "@/store/issue/issue-details/attachment.store";

export type TAttachmentOperations = {
  create: (file: File) => Promise<void>;
  createMany: (files: File[]) => Promise<void>;
  remove: (attachmentId: string) => Promise<void>;
};

export type TAttachmentSnapshot = {
  uploadStatus: TAttachmentUploadStatus[] | undefined;
};

export type TAttachmentHelpers = {
  operations: TAttachmentOperations;
  snapshot: TAttachmentSnapshot;
};

export const useAttachmentOperations = (
  workspaceSlug: string,
  projectId: string,
  issueId: string,
  issueServiceType: TIssueServiceType = EIssueServiceType.ISSUES
): TAttachmentHelpers => {
  const {
    attachment: { createAttachment, removeAttachment, getAttachmentsUploadStatusByIssueId },
  } = useIssueDetail(issueServiceType);

  const uploadAttachments = useCallback(
    async (files: File[]) => {
      if (!workspaceSlug || !projectId || !issueId) throw new Error("Missing required fields");
      if (files.length === 0) return;
      // Sequential execution keeps the issue attachment count and toast completion deterministic.
      const attachmentUploadPromise = (async () => {
        /* eslint-disable no-await-in-loop -- Sequential uploads prevent attachment-count races. */
        for (const file of files) {
          await createAttachment(workspaceSlug, projectId, issueId, file);
        }
        /* eslint-enable no-await-in-loop */
      })();
      setPromiseToast(attachmentUploadPromise, {
        loading: "Uploading attachment...",
        success: {
          title: "Attachment uploaded",
          message: () =>
            files.length === 1
              ? "The attachment has been successfully uploaded"
              : `${files.length} attachments have been successfully uploaded`,
        },
        error: {
          title: "Attachment not uploaded",
          message: () => "One or more attachments could not be uploaded",
        },
      });

      await attachmentUploadPromise;
    },
    [createAttachment, issueId, projectId, workspaceSlug]
  );

  const attachmentOperations: TAttachmentOperations = useMemo(
    () => ({
      create: async (file) => uploadAttachments([file]),
      createMany: uploadAttachments,
      remove: async (attachmentId) => {
        try {
          if (!workspaceSlug || !projectId || !issueId) throw new Error("Missing required fields");
          await removeAttachment(workspaceSlug, projectId, issueId, attachmentId);
          setToast({
            message: "The attachment has been successfully removed",
            type: TOAST_TYPE.SUCCESS,
            title: "Attachment removed",
          });
        } catch (_error) {
          setToast({
            message: "The Attachment could not be removed",
            type: TOAST_TYPE.ERROR,
            title: "Attachment not removed",
          });
        }
      },
    }),
    [uploadAttachments, workspaceSlug, projectId, issueId, removeAttachment]
  );
  const attachmentsUploadStatus = getAttachmentsUploadStatusByIssueId(issueId);

  return {
    operations: attachmentOperations,
    snapshot: { uploadStatus: attachmentsUploadStatus },
  };
};
