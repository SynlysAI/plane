/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect } from "react";
import { observer } from "mobx-react";
import { useParams } from "react-router";
// components
import { SettingsHeading } from "@/components/settings/heading";
import { ProjectSettingsFeatureControlItem } from "@/components/settings/project/content/feature-control-item";
// hooks
import { useLabel } from "@/hooks/store/use-label";
import { useModule } from "@/hooks/store/use-module";
import { useProject } from "@/hooks/store/use-project";

type Props = {
  projectId: string;
};

export const AdministrativeRequiredFieldSettings = observer(function AdministrativeRequiredFieldSettings(props: Props) {
  const { projectId } = props;
  const { workspaceSlug } = useParams();
  const { getProjectById } = useProject();
  const { fetchModules, getProjectModuleIds } = useModule();
  const { fetchProjectLabels, getProjectLabelIds } = useLabel();
  const project = getProjectById(projectId);

  useEffect(() => {
    if (!workspaceSlug || project?.is_research_project !== false) return;
    void Promise.all([fetchModules(workspaceSlug, projectId), fetchProjectLabels(workspaceSlug, projectId)]).catch(
      () => undefined
    );
  }, [fetchModules, fetchProjectLabels, project?.is_research_project, projectId, workspaceSlug]);

  if (!workspaceSlug || project?.is_research_project !== false) return null;

  const moduleIds = getProjectModuleIds(projectId) ?? [];
  const labelIds = getProjectLabelIds(projectId) ?? [];
  const moduleUnavailable = !project.module_view || moduleIds.length === 0;
  const labelUnavailable = labelIds.length === 0;

  return (
    <div className="mt-10">
      <SettingsHeading
        title="行政工作项必填项"
        description="正式行政工作项提交或转正前必须选择已开启的必填字段；草稿可暂缺。"
      />
      <div className="mt-6 flex flex-col gap-y-4">
        <ProjectSettingsFeatureControlItem
          description={
            moduleUnavailable ? "请先启用模块并创建至少一个模块。" : "创建与编辑正式行政工作项时必须选择模块。"
          }
          disabled={!project.is_module_required && moduleUnavailable}
          featureProperty="is_module_required"
          projectId={projectId}
          title="模块（财务报销科目）必选"
          value={Boolean(project.is_module_required)}
          workspaceSlug={workspaceSlug}
        />
        <ProjectSettingsFeatureControlItem
          description={labelUnavailable ? "请先创建至少一个标签。" : "创建与编辑正式行政工作项时必须选择标签。"}
          disabled={!project.is_label_required && labelUnavailable}
          featureProperty="is_label_required"
          projectId={projectId}
          title="标签（小组）必选"
          value={Boolean(project.is_label_required)}
          workspaceSlug={workspaceSlug}
        />
      </div>
    </div>
  );
});
