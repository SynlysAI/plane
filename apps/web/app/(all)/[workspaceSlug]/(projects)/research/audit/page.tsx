/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// components
import { ResearchAuditEventTable } from "@/components/research/audit/audit-event-table";
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { ResearchIaV2Redirect } from "@/components/research/navigation/research-ia-v2-redirect";

function WorkspaceResearchAuditContent() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;

  return (
    <ResearchPageShell
      titleKey="research.nav.audit"
      descriptionKey="research.audit.description"
      section="org"
      navKey="audit"
      adminOnly
      allowDisabled
    >
      <ResearchAuditEventTable workspaceSlug={workspaceSlug} />
    </ResearchPageShell>
  );
}

function WorkspaceResearchAuditPage() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;
  return (
    <ResearchIaV2Redirect to={`/${workspaceSlug}/research/settings/audit`}>
      <WorkspaceResearchAuditContent />
    </ResearchIaV2Redirect>
  );
}

export default observer(WorkspaceResearchAuditPage);
