/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// components
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { AgentBackendSettings } from "@/components/research/settings/system";

function WorkspaceResearchAgentBackendSettingsPage() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;

  return (
    <ResearchPageShell
      titleKey="research.nav.agent_backend"
      descriptionKey="research.agent_backend.description"
      section="integrations"
    >
      <AgentBackendSettings workspaceSlug={workspaceSlug} />
    </ResearchPageShell>
  );
}

export default observer(WorkspaceResearchAgentBackendSettingsPage);
