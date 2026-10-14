/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { observer } from "mobx-react";
import { RefreshCw } from "lucide-react";
// plane imports
import { INTEGRATION_HEALTH_LABELS, INTEGRATION_SYSTEM_LABELS } from "@plane/constants";
import type { TIntegrationConnection } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { ResearchTableSurface } from "@/components/research/common/research-data-surface";
import { formatResearchDateTime } from "@/components/research/common/research-format";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
  connections: TIntegrationConnection[];
  health: Array<Record<string, unknown>>;
};

/** Connection health: normal / degraded / unavailable / unconfigured (P1-INT-10). */
export const IntegrationHealthBoard = observer(function IntegrationHealthBoard({
  workspaceSlug,
  connections,
  health,
}: Props) {
  const { t, currentLocale } = useTranslation();
  const research = useResearch();
  const [probing, setProbing] = useState(false);
  const probe = async () => {
    setProbing(true);
    try {
      await research.probeIntegrationHealth(workspaceSlug);
    } finally {
      setProbing(false);
    }
  };
  const statusBySystem = new Map(health.map((entry) => [String(entry.system), entry]));
  const rows = connections.length
    ? connections
    : (["RAGPORTAL", "WEKNORA", "SYNLORA", "SPECLABOS", "SMARTACCESS", "POLY_AGENT", "SPEC_AGENT"] as const).map(
        (system) =>
          ({ system, is_enabled: false, configured: false, health_status: "UNKNOWN" }) as TIntegrationConnection
      );

  return (
    <ResearchTableSurface>
      <div className="mb-2 flex justify-end">
        <Button variant="secondary" size="sm" onClick={() => void probe()} disabled={probing}>
          <RefreshCw className={`size-3 ${probing ? "animate-spin" : ""}`} />
          {t("research.integrations.refresh_health")}
        </Button>
      </div>
      <Table>
        <TableHeader>
          <TableRow className="text-tertiary">
            <TableHead>{t("research.integrations.columns.system")}</TableHead>
            <TableHead>{t("research.integrations.columns.status")}</TableHead>
            <TableHead className="text-right">{t("research.integrations.columns.last_success")}</TableHead>
            <TableHead>{t("research.integrations.columns.reason")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((connection) => {
            const entry = statusBySystem.get(String(connection.system)) ?? {};
            const status = String(entry.status ?? connection.health_status ?? "UNKNOWN");
            const registrationStatus = String(entry.registration_status ?? connection.registration_status ?? "");
            const phaseOnly = registrationStatus === "PHASE_NOT_ENABLED";
            const proxy = registrationStatus === "PROXY";
            const showDisabled = registrationStatus === "REGISTERED_DISABLED";
            return (
              <TableRow key={connection.system}>
                <TableCell className="text-secondary">
                  {t(INTEGRATION_SYSTEM_LABELS[connection.system])}
                  {showDisabled && (
                    <span className="ml-2 text-11 text-tertiary">{t("research.integrations.disabled")}</span>
                  )}
                </TableCell>
                <TableCell>
                  <span
                    className={`rounded px-1.5 py-0.5 text-11 ${
                      status === "OK"
                        ? "bg-success-subtle text-success-primary"
                        : status === "DEGRADED"
                          ? "bg-danger-subtle text-danger-primary"
                          : "bg-surface-2 text-tertiary"
                    }`}
                  >
                    {phaseOnly
                      ? t("research.integrations.health.phase_not_enabled")
                      : proxy
                        ? t("research.integrations.health.proxy", {
                            system: entry.proxy_system ?? connection.proxy_system ?? "RAGPORTAL",
                          })
                        : registrationStatus === "NOT_REGISTERED"
                          ? t("research.integrations.health.not_registered")
                          : registrationStatus === "REGISTERED_DISABLED"
                            ? t("research.integrations.health.registered_disabled")
                            : t(INTEGRATION_HEALTH_LABELS[status] ?? INTEGRATION_HEALTH_LABELS.UNKNOWN)}
                  </span>
                </TableCell>
                <TableCell className="text-right text-tertiary tabular-nums">
                  {entry.last_success_at ? formatResearchDateTime(String(entry.last_success_at), currentLocale) : "-"}
                </TableCell>
                <TableCell className="text-tertiary">
                  {proxy
                    ? t("research.integrations.health.proxy_detail")
                    : String(entry.degraded_reason ?? connection.last_error ?? "") || "-"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ResearchTableSurface>
  );
});
