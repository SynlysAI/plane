/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// components
import { ResearchBackLink } from "@/components/research/common/research-back-link";
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { StageOverview } from "@/components/research/stages/stage-overview";

function WorkspaceResearchProjectStageDetailPage() {
  const { workspaceSlug, projectId, stageCode } = useParams();
  if (!workspaceSlug || !projectId) return null;

  return (
    <ResearchPageShell
      titleKey="research.nav.stages"
      descriptionKey="research.stages.description"
      section="stages"
      breadcrumbs={
        <ResearchBackLink href={`/${workspaceSlug}/research/projects/${projectId}/stages`}>
          返回科研阶段
        </ResearchBackLink>
      }
    >
      <StageOverview workspaceSlug={workspaceSlug} projectId={projectId} stageCode={stageCode} />
    </ResearchPageShell>
  );
}

export default observer(WorkspaceResearchProjectStageDetailPage);
