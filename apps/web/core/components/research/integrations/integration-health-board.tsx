/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { INTEGRATION_HEALTH_LABELS, INTEGRATION_SYSTEM_LABELS } from "@plane/constants";
import type { TIntegrationConnection } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { ResearchTableSurface } from "@/components/research/common/research-data-surface";
import { formatResearchDateTime } from "@/components/research/common/research-format";

type Props = {
  connections: TIntegrationConnection[];
  health: Array<Record<string, unknown>>;
};

/** Connection health: normal / degraded / unavailable / unconfigured (P1-INT-10). */
export const IntegrationHealthBoard = observer(function IntegrationHealthBoard({ connections, health }: Props) {
  const { t, currentLocale } = useTranslation();
  const statusBySystem = new Map(health.map((entry) => [String(entry.system), entry]));
  const rows = connections.length
    ? connections
    : (["RAGPORTAL", "WEKNORA", "SPECLABOS", "SMARTACCESS", "POLY_AGENT", "SPEC_AGENT"] as const).map(
        (system) =>
          ({ system, is_enabled: false, configured: false, health_status: "UNKNOWN" }) as TIntegrationConnection
      );

  return (
    <ResearchTableSurface>
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
            return (
              <TableRow key={connection.system}>
                <TableCell className="text-secondary">
                  {t(INTEGRATION_SYSTEM_LABELS[connection.system])}
                  {!connection.is_enabled && (
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
                    {t(INTEGRATION_HEALTH_LABELS[status] ?? INTEGRATION_HEALTH_LABELS.UNKNOWN)}
                  </span>
                </TableCell>
                <TableCell className="text-right text-tertiary tabular-nums">
                  {entry.last_success_at ? formatResearchDateTime(String(entry.last_success_at), currentLocale) : "-"}
                </TableCell>
                <TableCell className="text-tertiary">
                  {String(entry.degraded_reason ?? connection.last_error ?? "") || "-"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ResearchTableSurface>
  );
});
