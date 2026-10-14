/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
import { useTranslation } from "@plane/i18n";
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { AgentBackendSettings } from "@/components/research/settings/system";
import { useResearch } from "@/hooks/store/use-research";
import { useWorkspace } from "@/hooks/store/use-workspace";

function WorkspaceResearchAgentBackendSettingsPage() {
  const { t } = useTranslation();
  const { workspaceSlug } = useParams();
  const research = useResearch();
  const { getWorkspaceBySlug } = useWorkspace();
  if (!workspaceSlug) return null;

  return (
    <ResearchPageShell
      titleKey="research.nav.agent_backend"
      descriptionKey="research.agent_backend.description"
      section="research_agent"
    >
      {research.canConfigurePersonalAgentBackend ? (
        <AgentBackendSettings
          key={workspaceSlug}
          workspaceSlug={workspaceSlug}
          workspaceName={getWorkspaceBySlug(workspaceSlug)?.name ?? workspaceSlug}
        />
      ) : (
        <p className="p-5 text-13 text-secondary">{t("research.agent_backend.access_denied")}</p>
      )}
    </ResearchPageShell>
  );
}

export default observer(WorkspaceResearchAgentBackendSettingsPage);
