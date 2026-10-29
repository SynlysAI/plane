/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React from "react";
import { observer } from "mobx-react";
import type { Control } from "react-hook-form";
import { Controller } from "react-hook-form";
// plane imports
import { CloseOutline } from "@makeplane/propel/icons";
import { ETabIndices } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
// types
import type { TIssue } from "@plane/types";
import { getTabIndex } from "@plane/utils";
// components
import { ProjectDropdown } from "@/components/dropdowns/project/dropdown";
// hooks
import { useIssueModal } from "@/hooks/context/use-issue-modal";
import { usePlatformOS } from "@/hooks/use-platform-os";

type TIssueProjectSelectProps = {
  control: Control<TIssue>;
  disabled?: boolean;
  handleFormChange: () => void;
};

export const IssueProjectSelect = observer(function IssueProjectSelect(props: TIssueProjectSelectProps) {
  const { control, disabled = false, handleFormChange } = props;
  const { t } = useTranslation();
  // store hooks
  const { isMobile } = usePlatformOS();
  // context hooks
  const { allowedProjectIds } = useIssueModal();

  const { getIndex } = getTabIndex(ETabIndices.ISSUE_FORM, isMobile);

  return (
    <Controller
      control={control}
      name="project_id"
      rules={{
        required: true,
      }}
      render={({ field: { value, onChange } }) => (
        <div className="flex h-7 items-center gap-1">
          <ProjectDropdown
            value={value}
            onChange={(projectId) => {
              onChange(projectId);
              handleFormChange();
            }}
            multiple={false}
            buttonVariant="border-with-text"
            renderCondition={(projectId) => allowedProjectIds.includes(projectId)}
            tabIndex={getIndex("project_id")}
            disabled={disabled}
            placeholder={t("select_project")}
          />
          {!disabled && value && (
            <button
              type="button"
              aria-label={t("clear_project")}
              title={t("clear_project")}
              className="hover:bg-surface-hover focus-visible:ring-border-strong grid size-6 place-items-center rounded-md text-tertiary transition-colors hover:text-secondary focus-visible:ring-1 focus-visible:outline-none"
              onClick={(event) => {
                event.stopPropagation();
                onChange(null);
                handleFormChange();
              }}
            >
              <CloseOutline className="size-3.5" />
            </button>
          )}
        </div>
      )}
    />
  );
});
