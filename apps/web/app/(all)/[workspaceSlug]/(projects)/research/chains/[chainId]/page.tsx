/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
// components
import { ResearchBackLink } from "@/components/research/common/research-back-link";
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { ResearchChainDetail } from "@/components/research/chains/research-chain-detail";

function WorkspaceResearchChainDetailPage() {
  const { workspaceSlug, chainId } = useParams();
  if (!workspaceSlug || !chainId) return null;

  return (
    <ResearchPageShell
      titleKey="research.nav.research_chain"
      descriptionKey="research.chains.description"
      section="research_chain"
      breadcrumbs={<ResearchBackLink href={`/${workspaceSlug}/research/chains`}>返回课题列表</ResearchBackLink>}
    >
      <ResearchChainDetail workspaceSlug={workspaceSlug} chainId={chainId} />
    </ResearchPageShell>
  );
}

export default observer(WorkspaceResearchChainDetailPage);
