/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { observer } from "mobx-react";
import { useParams, useSearchParams } from "react-router";
// components
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { ResearchChainWorkbench } from "@/components/research/chains/research-chain-workbench";

function WorkspaceResearchChainsPage() {
  const { workspaceSlug } = useParams();
  const [searchParams] = useSearchParams();
  if (!workspaceSlug) return null;
  const descriptionKey =
    searchParams.get("view") === "projects"
      ? "research.chains.project_records_description"
      : "research.chains.description";

  return (
    <ResearchPageShell
      titleKey="research.nav.research_chain_v2"
      descriptionKey={descriptionKey}
      section="research_chain"
    >
      <ResearchChainWorkbench workspaceSlug={workspaceSlug} />
    </ResearchPageShell>
  );
}

export default observer(WorkspaceResearchChainsPage);
