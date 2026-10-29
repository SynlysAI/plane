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
  const { fetchModules, getProjectModuleDetails } = useModule();
  const { fetchProjectLabels, getProjectLabels } = useLabel();
  const project = getProjectById(projectId);

  useEffect(() => {
    if (!workspaceSlug || project?.is_research_project !== false) return;
    void Promise.all([fetchModules(workspaceSlug, projectId), fetchProjectLabels(workspaceSlug, projectId)]).catch(
      () => undefined
    );
  }, [fetchModules, fetchProjectLabels, project?.is_research_project, projectId, workspaceSlug]);

  if (!workspaceSlug || project?.is_research_project !== false) return null;

  const modules = getProjectModuleDetails(projectId);
  const labels = getProjectLabels(projectId);
  const moduleNames = (modules ?? []).map((module) => module.name?.trim() || "未命名模块");
  const labelNames = (labels ?? []).map((label) => label.name?.trim() || "未命名标签");
  const moduleLoading = modules === null;
  const labelLoading = labels === undefined;
  const moduleUnavailable = !project.module_view || moduleNames.length === 0;
  const labelUnavailable = labelNames.length === 0;
  let moduleOptionDescription = `当前可选模块：${moduleNames.join("、")}`;
  if (moduleLoading) {
    moduleOptionDescription = "正在读取模块...";
  } else if (!project.module_view) {
    moduleOptionDescription = "请先启用模块功能。";
  } else if (moduleNames.length === 0) {
    moduleOptionDescription = "请先创建至少一个模块。";
  }

  let labelOptionDescription = `当前可选标签：${labelNames.join("、")}`;
  if (labelLoading) {
    labelOptionDescription = "正在读取标签...";
  } else if (labelNames.length === 0) {
    labelOptionDescription = "请先创建至少一个标签。";
  }

  return (
    <div className="mt-10">
      <SettingsHeading
        title="行政工作项必填项"
        description="正式行政工作项提交或转正前必须选择已开启的必填字段；草稿可暂缺。"
      />
      <div className="mt-6 flex flex-col gap-y-4">
        <ProjectSettingsFeatureControlItem
          description={
            <span className="block break-words">
              <span className="block">创建与编辑正式行政工作项时必须选择模块；草稿转正前需补齐。</span>
              <span className="block">{moduleOptionDescription}</span>
            </span>
          }
          disabled={moduleLoading || (!project.is_module_required && moduleUnavailable)}
          featureProperty="is_module_required"
          projectId={projectId}
          title="模块必选"
          value={Boolean(project.is_module_required)}
          workspaceSlug={workspaceSlug}
        />
        <ProjectSettingsFeatureControlItem
          description={
            <span className="block break-words">
              <span className="block">创建与编辑正式行政工作项时必须选择标签；草稿转正前需补齐。</span>
              <span className="block">{labelOptionDescription}</span>
            </span>
          }
          disabled={labelLoading || (!project.is_label_required && labelUnavailable)}
          featureProperty="is_label_required"
          projectId={projectId}
          title="标签必选"
          value={Boolean(project.is_label_required)}
          workspaceSlug={workspaceSlug}
        />
      </div>
    </div>
  );
});
