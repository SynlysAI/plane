/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// components
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { ResearchChainBoard } from "@/components/research/chains/research-chain-board";

function WorkspaceResearchChainsPage() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;

  return (
    <ResearchPageShell
      titleKey="research.nav.research_chain"
      descriptionKey="research.chains.description"
      section="research_chain"
      navKey="research_chain"
    >
      <ResearchChainBoard workspaceSlug={workspaceSlug} />
    </ResearchPageShell>
  );
}

export default observer(WorkspaceResearchChainsPage);
