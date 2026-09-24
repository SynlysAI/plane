/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// components
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { ResearchIaV2Redirect } from "@/components/research/navigation/research-ia-v2-redirect";
import { ResearchProjectList } from "@/components/research/projects/research-project-list";
// hooks
import { useUser } from "@/hooks/store/user";

function WorkspaceResearchProjectsContent() {
  const { workspaceSlug } = useParams();
  const { data: currentUser } = useUser();
  if (!workspaceSlug) return null;

  return (
    <ResearchPageShell
      titleKey="research.nav.projects"
      descriptionKey="research.projects.description"
      section="reports"
      navKey="projects"
    >
      <ResearchProjectList workspaceSlug={workspaceSlug} currentUserId={currentUser?.id ?? ""} />
    </ResearchPageShell>
  );
}

function WorkspaceResearchProjectsPage() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;
  return (
    <ResearchIaV2Redirect to={`/${workspaceSlug}/research/chains`} query={{ view: "projects" }}>
      <WorkspaceResearchProjectsContent />
    </ResearchIaV2Redirect>
  );
}

export default observer(WorkspaceResearchProjectsPage);
