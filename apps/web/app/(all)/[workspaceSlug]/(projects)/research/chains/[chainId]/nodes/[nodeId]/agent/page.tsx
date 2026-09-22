/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// components
import { ResearchAgentPlugin } from "@/components/research/agent/research-agent-plugin";
import { ResearchPageShell } from "@/components/research/common/research-page-shell";

function WorkspaceResearchAgentPage() {
  const { workspaceSlug, nodeId } = useParams();
  if (!workspaceSlug || !nodeId) return null;

  return (
    <ResearchPageShell
      titleKey="research.nav.research_chain"
      descriptionKey="research.agent.description"
      section="research_agent"
      navKey="research_chain"
    >
      <ResearchAgentPlugin workspaceSlug={workspaceSlug} chainNodeId={nodeId} />
    </ResearchPageShell>
  );
}

export default observer(WorkspaceResearchAgentPage);
