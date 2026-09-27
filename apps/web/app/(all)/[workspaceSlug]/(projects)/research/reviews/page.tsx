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
import { ReviewInbox } from "@/components/research/reviews/review-inbox";

function WorkspaceResearchReviewsContent() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;

  return (
    <ResearchPageShell
      titleKey="research.nav.reviews"
      descriptionKey="research.reviews.description"
      section="stages"
      navKey="reviews"
    >
      <ReviewInbox workspaceSlug={workspaceSlug} />
    </ResearchPageShell>
  );
}

function WorkspaceResearchReviewsPage() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;
  return (
    <ResearchIaV2Redirect to={`/${workspaceSlug}/research/approvals`} query={{ tab: "stage_review" }}>
      <WorkspaceResearchReviewsContent />
    </ResearchIaV2Redirect>
  );
}

export default observer(WorkspaceResearchReviewsPage);
