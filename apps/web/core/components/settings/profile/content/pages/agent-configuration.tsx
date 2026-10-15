"use client";

import { useEffect } from "react";
import { observer } from "mobx-react";
import { useTranslation } from "@plane/i18n";
import { AgentBackendSettings } from "@/components/research/settings/system/agent-backend-settings";
import { useResearch } from "@/hooks/store/use-research";
import { useWorkspace } from "@/hooks/store/use-workspace";

/** 在 Developer 设置中显示当前工作区的个人 ScienceDiscovery 连接。 */
export const AgentConfigurationProfileSettings = observer(function AgentConfigurationProfileSettings() {
  const { t } = useTranslation();
  const { currentWorkspace } = useWorkspace();
  const research = useResearch();
  const workspaceSlug = currentWorkspace?.slug;

  useEffect(() => {
    if (workspaceSlug && (research.identityWorkspaceSlug !== workspaceSlug || !research.identity)) {
      void research.fetchIdentity(workspaceSlug).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug]);

  if (!workspaceSlug) {
    return <p className="text-13 text-secondary">{t("research.agent_backend.no_workspace")}</p>;
  }

  if (research.identityWorkspaceSlug === workspaceSlug && research.identityErrorCode) {
    const denied =
      research.identityErrorCode === "research_permission_denied" ||
      research.identityErrorCode === "research_workspace_not_found";
    return (
      <p className="text-13 text-secondary">
        {t(denied ? "research.agent_backend.access_denied" : "research.agent_backend.load_failed")}
      </p>
    );
  }

  if (research.identityLoader || research.identityWorkspaceSlug !== workspaceSlug || !research.identity) {
    return <p className="text-13 text-tertiary">{t("research.common.loading")}</p>;
  }

  if (!research.canConfigurePersonalAgentBackend) {
    return <p className="text-13 text-secondary">{t("research.agent_backend.access_denied")}</p>;
  }

  return (
    <AgentBackendSettings
      key={workspaceSlug}
      workspaceSlug={workspaceSlug}
      workspaceName={currentWorkspace?.name ?? workspaceSlug}
    />
  );
});
