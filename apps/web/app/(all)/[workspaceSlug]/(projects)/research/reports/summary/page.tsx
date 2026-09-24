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
import { ResearchReportSummaryBoard } from "@/components/research/reports/report-summary-board";

function WorkspaceResearchSummaryContent() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;

  return (
    <ResearchPageShell
      titleKey="research.nav.summary"
      descriptionKey="research.summary.description"
      section="reports"
      navKey="summary"
    >
      <ResearchReportSummaryBoard workspaceSlug={workspaceSlug} />
    </ResearchPageShell>
  );
}

function WorkspaceResearchSummaryPage() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;
  return (
    <ResearchIaV2Redirect to={`/${workspaceSlug}/research`} query={{ view: "report_submission" }}>
      <WorkspaceResearchSummaryContent />
    </ResearchIaV2Redirect>
  );
}

export default observer(WorkspaceResearchSummaryPage);
