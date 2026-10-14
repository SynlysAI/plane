/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// components
import { AdministrativeProjectTabs } from "@/components/administrative/administrative-project-tabs";
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { ResearchProjectList } from "@/components/research/projects/research-project-list";
// hooks
import { useResearch } from "@/hooks/store/use-research";
import { useUser } from "@/hooks/store/user";

function WorkspaceResearchProjectsPage() {
  const { workspaceSlug } = useParams();
  const { data: currentUser } = useUser();
  const research = useResearch();
  if (!workspaceSlug) return null;

  return (
    <AdministrativeProjectTabs workspaceSlug={workspaceSlug} activeTab="research-projects">
      <ResearchPageShell
        titleKey="research.nav.projects"
        descriptionKey="research.projects.description"
        section="reports"
        navKey="projects"
        embedded={research.isIaV2Enabled}
      >
        <ResearchProjectList workspaceSlug={workspaceSlug} currentUserId={currentUser?.id ?? ""} />
      </ResearchPageShell>
    </AdministrativeProjectTabs>
  );
}

export default observer(WorkspaceResearchProjectsPage);
