/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

// components
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { TLabelOperations } from "../root";
import { IssueLabelSelect } from "./label-select";
import { REQUIRED_FIELD_MESSAGES, isRequiredSelectionMissing } from "@/components/issues/required-fields";
import { useProject } from "@/hooks/store/use-project";
// types

type TIssueLabelSelectRoot = {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  values: string[];
  labelOperations: TLabelOperations;
};

export function IssueLabelSelectRoot(props: TIssueLabelSelectRoot) {
  const { workspaceSlug, projectId, issueId, values, labelOperations } = props;
  const { getProjectById } = useProject();
  const project = getProjectById(projectId);

  const handleLabel = async (_labelIds: string[]) => {
    if (isRequiredSelectionMissing(project, "label_ids", _labelIds)) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Error!",
        message: REQUIRED_FIELD_MESSAGES.label_ids,
      });
      return;
    }
    await labelOperations.updateIssue(workspaceSlug, projectId, issueId, { label_ids: _labelIds });
  };

  return (
    <IssueLabelSelect
      workspaceSlug={workspaceSlug}
      projectId={projectId}
      issueId={issueId}
      values={values}
      onSelect={handleLabel}
      onAddLabel={labelOperations.createLabel}
    />
  );
}
