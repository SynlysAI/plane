/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { INTEGRATION_SYSTEM_LABELS } from "@plane/constants";
import type { TIntegrationCallLog } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { ResearchTableSurface } from "@/components/research/common/research-data-surface";

type Props = {
  logs: TIntegrationCallLog[];
};

/** Read-only call log: metadata only, never a payload copy (P1-INT-08). */
export const ExternalCallLogTable = observer(function ExternalCallLogTable({ logs }: Props) {
  const { t } = useTranslation();
  if (!logs.length) return <p className="text-12 text-tertiary">{t("research.integrations.no_logs")}</p>;
  return (
    <ResearchTableSurface>
      <Table>
        <TableHeader>
          <TableRow className="text-tertiary">
            <TableHead>{t("research.integrations.columns.system")}</TableHead>
            <TableHead>{t("research.integrations.columns.operation")}</TableHead>
            <TableHead>{t("research.integrations.columns.outcome")}</TableHead>
            <TableHead className="text-right">{t("research.integrations.columns.latency")}</TableHead>
            <TableHead>{t("research.integrations.columns.error")}</TableHead>
            <TableHead className="text-right">{t("research.integrations.columns.time")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {logs.map((log) => (
            <TableRow key={log.id}>
              <TableCell className="text-tertiary">{t(INTEGRATION_SYSTEM_LABELS[log.system] ?? log.system)}</TableCell>
              <TableCell className="text-secondary">{log.operation}</TableCell>
              <TableCell className="text-tertiary">{log.outcome}</TableCell>
              <TableCell className="text-right text-tertiary tabular-nums">{log.latency_ms ?? "-"}</TableCell>
              <TableCell className="text-tertiary">{log.error_code || "-"}</TableCell>
              <TableCell className="text-right text-tertiary tabular-nums">
                {new Date(log.created_at).toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ResearchTableSurface>
  );
});
