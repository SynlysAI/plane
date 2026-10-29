/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { Button } from "@plane/propel/button";
import { CloseOutline, LabelsFilled } from "@makeplane/propel/icons";
// types
import { useLabel } from "@/hooks/store/use-label";
import { useProject } from "@/hooks/store/use-project";
import { REQUIRED_FIELD_MESSAGES, isRequiredSelectionMissing } from "@/components/issues/required-fields";
import type { TLabelOperations } from "./root";

type TLabelListItem = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  labelId: string;
  values: string[];
  labelOperations: TLabelOperations;
  disabled: boolean;
};

export const LabelListItem = observer(function LabelListItem(props: TLabelListItem) {
  const { workspaceSlug, projectId, issueId, labelId, values, labelOperations, disabled } = props;
  // hooks
  const { getLabelById } = useLabel();
  const { getProjectById } = useProject();
  const project = getProjectById(projectId);

  const label = getLabelById(labelId);

  const handleLabel = async () => {
    if (values && !disabled) {
      const currentLabels = values.filter((_labelId) => _labelId !== labelId);
      if (isRequiredSelectionMissing(project, "label_ids", currentLabels)) {
        setToast({
          type: TOAST_TYPE.ERROR,
          title: "Error!",
          message: REQUIRED_FIELD_MESSAGES.label_ids,
        });
        return;
      }
      await labelOperations.updateIssue(workspaceSlug, projectId, issueId, { label_ids: currentLabels });
    }
  };

  if (!label) return <></>;
  return (
    <Button variant="tertiary" size="sm" key={labelId} onClick={handleLabel} disabled={disabled}>
      <LabelsFilled className="size-3" color={label.color ?? "#000000"} />
      <span className="text-body-xs-regular">{label.name}</span>
      {!disabled && <CloseOutline className="h-2.5 w-2.5 transition-all group-hover:text-danger-primary" />}
    </Button>
  );
});
