/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { setPromiseToast } from "@plane/propel/toast";
import type { IProject } from "@plane/types";
import { Switch } from "@makeplane/propel/components/switch";
// components
import { SettingsBoxedControlItem } from "@/components/settings/boxed-control-item";
// hooks
import { useAdministrativeSettingsLock } from "@/hooks/use-administrative-settings-lock";
import { useProject } from "@/hooks/store/use-project";

type Props = {
  description?: React.ReactNode;
  disabled?: boolean;
  projectId: string;
  featureProperty: keyof IProject;
  title: React.ReactNode;
  value: boolean;
  workspaceSlug: string;
};

export const ProjectSettingsFeatureControlItem = observer(function ProjectSettingsFeatureControlItem(props: Props) {
  const { description, disabled, featureProperty, projectId, title, value, workspaceSlug } = props;
  // store hooks
  const { getProjectById, updateProject } = useProject();
  const isAdministrativeSettingsLocked = useAdministrativeSettingsLock(projectId);
  // derived values
  const currentProjectDetails = getProjectById(projectId);
  const isFeatureLocked =
    isAdministrativeSettingsLocked &&
    ["module_view", "issue_views_view", "is_module_required", "is_label_required"].includes(featureProperty);

  const handleSubmit = () => {
    if (!workspaceSlug || !projectId || !currentProjectDetails) return;

    // making the request to update the project feature
    const settingsPayload = {
      [featureProperty]: !currentProjectDetails?.[featureProperty],
    };
    const updateProjectPromise = updateProject(workspaceSlug, projectId, settingsPayload);

    setPromiseToast(updateProjectPromise, {
      loading: "Updating project feature...",
      success: {
        title: "Success!",
        message: () => "Project feature updated successfully.",
      },
      error: {
        title: "Error!",
        message: () => "Something went wrong while updating project feature. Please try again.",
      },
    });
    void updateProjectPromise.then(() => {
      return undefined;
    });
  };

  return (
    <SettingsBoxedControlItem
      title={title}
      description={
        isFeatureLocked ? (
          <>
            {description}
            <span className="mt-1 block text-12 text-tertiary">该项已由项目管理员统一设置。</span>
          </>
        ) : (
          description
        )
      }
      control={
        <Switch
          size="sm"
          checked={value}
          onCheckedChange={handleSubmit}
          disabled={disabled || isFeatureLocked}
          aria-label={typeof title === "string" ? title : "Toggle project feature"}
        />
      }
    />
  );
});
