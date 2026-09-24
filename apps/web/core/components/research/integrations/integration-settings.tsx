/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { useTranslation } from "@plane/i18n";
// components
import { ResearchDetailSurface, ResearchListSurface } from "@/components/research/common/research-data-surface";
import { ExternalCallLogTable } from "@/components/research/integrations/external-call-log-table";
import { ExternalReferencePicker } from "@/components/research/integrations/external-reference-picker";
import { IntegrationConnectionForm } from "@/components/research/integrations/integration-connection-form";
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

  return (
    <ResearchListSurface>
      <ResearchDetailSurface title={t("research.integrations.connections_title")}>
        <IntegrationConnectionForm
          connections={research.integrationConnections}
          onSave={async (items) => {
            await research.updateIntegrations(
              workspaceSlug,
              items as Parameters<typeof research.updateIntegrations>[1]
            );
          }}
        />
        <IntegrationHealthBoard connections={research.integrationConnections} health={research.integrationHealth} />
      </ResearchDetailSurface>

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
