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
import { ResearchReportDetail } from "@/components/research/reports/report-detail";

function WorkspaceResearchReportDetailPage() {
  const { workspaceSlug, reportId } = useParams();
  if (!workspaceSlug || !reportId) return null;

  return (
    <ResearchPageShell
      titleKey="research.reports.detail_title"
      descriptionKey="research.reports.detail_description"
      section="reports"
      navKey="reports"
      breadcrumbs={<ResearchBackLink href={`/${workspaceSlug}/research/reports`}>返回报告列表</ResearchBackLink>}
    >
      <ResearchReportDetail workspaceSlug={workspaceSlug} reportId={reportId} />
    </ResearchPageShell>
  );
}

export default observer(WorkspaceResearchReportDetailPage);
