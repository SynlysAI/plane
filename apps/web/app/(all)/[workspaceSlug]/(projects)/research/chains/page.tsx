/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// components
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { ResearchChainWorkbench } from "@/components/research/chains/research-chain-workbench";
import { useResearch } from "@/hooks/store/use-research";

function WorkspaceResearchChainsPage() {
  const { workspaceSlug } = useParams();
  const research = useResearch();
  if (!workspaceSlug) return null;

  return (
    <ResearchPageShell
      titleKey={research.isIaV2Enabled ? "research.nav.research_chain_v2" : "research.nav.research_chain"}
      descriptionKey="research.chains.description"
      section="research_chain"
    >
      <ResearchChainWorkbench workspaceSlug={workspaceSlug} />
    </ResearchPageShell>
  );
}

export default observer(WorkspaceResearchChainsPage);
