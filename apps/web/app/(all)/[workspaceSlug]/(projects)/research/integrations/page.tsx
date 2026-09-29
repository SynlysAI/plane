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
import { IntegrationSettings } from "@/components/research/integrations/integration-settings";

function WorkspaceResearchIntegrationsContent() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;

  return (
    <ResearchPageShell
      titleKey="research.nav.integrations"
      descriptionKey="research.integrations.description"
      section="integrations"
      navKey="integrations"
      adminOnly
    >
      <IntegrationSettings workspaceSlug={workspaceSlug} />
    </ResearchPageShell>
  );
}

function WorkspaceResearchIntegrationsPage() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;
  return (
    <ResearchIaV2Redirect to={`/${workspaceSlug}/research/settings/integrations`}>
      <WorkspaceResearchIntegrationsContent />
    </ResearchIaV2Redirect>
  );
}

export default observer(WorkspaceResearchIntegrationsPage);
