/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { RefreshCw } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
// components
import { ResearchDetailSurface, ResearchListSurface } from "@/components/research/common/research-data-surface";
import { ExternalCallLogTable } from "@/components/research/integrations/external-call-log-table";
import { ExternalReferencePicker } from "@/components/research/integrations/external-reference-picker";
import { IntegrationConnectionModal } from "@/components/research/integrations/integration-connection-modal";
import { IntegrationHealthBoard } from "@/components/research/integrations/integration-health-board";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
};

/** Administrator integration console: connections, health, references, logs. */
export const IntegrationSettings = observer(function IntegrationSettings({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const [loaded, setLoaded] = useState(false);
  const [probing, setProbing] = useState(false);
  const [editingSystem, setEditingSystem] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      await research.fetchIntegrations(workspaceSlug).catch(() => undefined);
      await Promise.all([
        research.fetchIntegrationHealth(workspaceSlug).catch(() => undefined),
        research.fetchExternalReferences(workspaceSlug).catch(() => undefined),
        research.fetchIntegrationCallLogs(workspaceSlug).catch(() => undefined),
      ]);
      setLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug]);

  const probe = async () => {
    setProbing(true);
    try {
      await research.probeIntegrationHealth(workspaceSlug);
    } finally {
      setProbing(false);
    }
  };

  const toggleConnection = async (system: string, enabled: boolean) => {
    const connection = research.integrationConnections.find((item) => item.system === system);
    setToggling(system);
    try {
      await research.updateIntegrations(workspaceSlug, [
        {
          system,
          display_name: connection?.display_name ?? system,
          base_url: connection?.base_url ?? "",
          is_enabled: enabled,
        },
      ]);
    } finally {
      setToggling(null);
    }
  };

  const editingConnection = research.integrationConnections.find((item) => item.system === editingSystem);

  return (
    <ResearchListSurface>
      <ResearchDetailSurface title={t("research.integrations.connections_title")}>
        <div className="mb-2 flex justify-end">
          <Button variant="secondary" size="sm" onClick={() => void probe()} disabled={probing}>
            <RefreshCw className={`size-3 ${probing ? "animate-spin" : ""}`} />
            {t("research.integrations.refresh_health")}
          </Button>
        </div>
        <IntegrationHealthBoard
          connections={research.integrationConnections}
          health={research.integrationHealth}
          onEdit={(system) => setEditingSystem(system)}
          onToggle={(connection) => void toggleConnection(String(connection.system), !connection.is_enabled)}
          toggling={toggling}
        />
      </ResearchDetailSurface>

      {editingSystem && (
        <IntegrationConnectionModal
          workspaceSlug={workspaceSlug}
          system={editingSystem}
          connection={editingConnection}
          onClose={() => setEditingSystem(null)}
        />
      )}

      <ResearchDetailSurface title={t("research.integrations.references_title")}>
        <ExternalReferencePicker workspaceSlug={workspaceSlug} />
      </ResearchDetailSurface>

      {loaded && research.isWorkspaceAdmin && (
        <ResearchDetailSurface title={t("research.integrations.call_logs_title")} collapsible>
          <ExternalCallLogTable logs={research.integrationCallLogs} />
        </ResearchDetailSurface>
      )}
    </ResearchListSurface>
  );
});
