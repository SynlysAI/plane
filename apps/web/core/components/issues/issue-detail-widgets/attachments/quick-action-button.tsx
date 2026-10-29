/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useCallback, useRef, useState } from "react";
import { observer } from "mobx-react";
import { AddOutline } from "@makeplane/propel/icons";
import { useTranslation } from "@plane/i18n";
import type { TIssueServiceType } from "@plane/types";
// hooks
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
// plane web hooks
import { useIssueAttachmentLimits } from "@/hooks/use-issue-attachment-limits";
// local imports
import { useAttachmentOperations } from "./helper";

type Props = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  customButton?: React.ReactNode;
  disabled?: boolean;
  issueServiceType: TIssueServiceType;
};

export const IssueAttachmentActionButton = observer(function IssueAttachmentActionButton(props: Props) {
  const { workspaceSlug, projectId, issueId, customButton, disabled = false, issueServiceType } = props;
  const { t } = useTranslation();
  // state
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // store hooks
  const { setLastWidgetAction, fetchActivities } = useIssueDetail(issueServiceType);
  // file size categories
  const { isLoading: limitsLoading } = useIssueAttachmentLimits(workspaceSlug, projectId);
  // operations
  const { operations: attachmentOperations } = useAttachmentOperations(
    workspaceSlug,
    projectId,
    issueId,
    issueServiceType
  );
  // handlers
  const handleFetchPropertyActivities = useCallback(() => {
    fetchActivities(workspaceSlug, projectId, issueId);
  }, [fetchActivities, workspaceSlug, projectId, issueId]);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || !workspaceSlug) return;

      setIsLoading(true);
      try {
        await attachmentOperations.createMany(files);
      } catch {
        // The shared attachment operation owns upload error notifications.
      } finally {
        handleFetchPropertyActivities();
        setLastWidgetAction("attachments");
        setIsLoading(false);
      }
    },
    [attachmentOperations, handleFetchPropertyActivities, setLastWidgetAction, workspaceSlug]
  );

  return (
    <div
      role="presentation"
      onClick={(e) => {
        // TODO: Remove extra div and move event propagation to button
        e.stopPropagation();
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        aria-label={t("common.attach")}
        disabled={disabled || limitsLoading || isLoading}
        onChange={(event) => {
          void handleFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = "";
        }}
      />
      <button
        type="button"
        className="hover:bg-surface-hover focus-visible:ring-border-strong flex size-7 items-center justify-center rounded-md text-tertiary transition-colors hover:text-secondary focus-visible:ring-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled || limitsLoading || isLoading}
        aria-label={t("common.attach")}
        title={t("common.attach")}
        onClick={() => inputRef.current?.click()}
      >
        {customButton ? customButton : <AddOutline className="h-4 w-4" />}
      </button>
    </div>
  );
});
