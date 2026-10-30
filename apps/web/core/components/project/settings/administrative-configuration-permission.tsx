/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// components
import { SettingsHeading } from "@/components/settings/heading";
import { ProjectSettingsFeatureControlItem } from "@/components/settings/project/content/feature-control-item";
// hooks
import { useProject } from "@/hooks/store/use-project";

type Props = {
  projectId: string;
};

export const AdministrativeConfigurationPermissionSettings = observer(
  function AdministrativeConfigurationPermissionSettings(props: Props) {
    const { projectId } = props;
    const { workspaceSlug } = useParams();
    const { getProjectById } = useProject();
    const project = getProjectById(projectId);

    if (!workspaceSlug || project?.is_research_project !== false) return null;

    return (
      <div className="mt-10">
        <SettingsHeading
          title="行政项目配置权限"
          description="按项目控制模块、标签与视图配置权；不同行政项目可以使用不同策略。"
        />
        <div className="mt-6">
          <ProjectSettingsFeatureControlItem
            description="开启后，模块开启及设置、视图锁定、标签开启及设定仅项目管理员可修改；成员可继续选择已建模块、已选标签和已有视图。"
            featureProperty="administrative_settings_admin_only"
            projectId={projectId}
            title="行政项目配置仅管理员可设置"
            value={Boolean(project.administrative_settings_admin_only)}
            workspaceSlug={workspaceSlug}
          />
        </div>
      </div>
    );
  }
);
