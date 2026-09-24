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
import { ResearchReportList } from "@/components/research/reports/report-list";

function WorkspaceResearchReportsContent() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;

  return (
    <ResearchPageShell
      titleKey="research.nav.reports"
      descriptionKey="research.reports.description"
      section="reports"
      navKey="reports"
    >
      <ResearchReportList workspaceSlug={workspaceSlug} />
    </ResearchPageShell>
  );
}

function WorkspaceResearchReportsPage() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;
  return (
    <ResearchIaV2Redirect to={`/${workspaceSlug}/research/chains`} query={{ view: "reports" }}>
      <WorkspaceResearchReportsContent />
    </ResearchIaV2Redirect>
  );
}

export default observer(WorkspaceResearchReportsPage);
