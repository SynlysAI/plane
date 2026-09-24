/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { Button } from "@plane/propel/button";
import { Input } from "@plane/ui";
// components
import { getResearchErrorKey } from "@/components/research/common/error-messages";
import {
  ResearchFilterToolbar,
  ResearchListSurface,
  ResearchTableSurface,
} from "@/components/research/common/research-data-surface";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
};

/** Extract readable audit values and omit opaque technical JSON. */
function auditMetadataSummary(metadata: Record<string, unknown>) {
  return Object.entries(metadata ?? {})
    .filter(
      ([key, value]) =>
        ["decision", "reason", "status", "action", "name", "title", "summary"].includes(key) &&
        typeof value !== "object"
    )
    .map(([key, value]) => `${key}: ${String(value)}`)
    .slice(0, 4)
    .join(" · ");
}

/** Read-only audit trail viewer (P0-AUD-05). */
export const ResearchAuditEventTable = observer(function ResearchAuditEventTable({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const [action, setAction] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const events = research.getAuditEvents(workspaceSlug);

  const load = useCallback(async () => {
    const params: Record<string, string> = {};
    if (action) params.action = action;
    if (resourceType) params.resource_type = resourceType;
    if (from) params.from = from;
    if (to) params.to = to;
    try {
      await research.fetchAuditEvents(workspaceSlug, params);
      setErrorKey(null);
    } catch (error) {
      setErrorKey(getResearchErrorKey(error));
    }
  }, [action, from, research, resourceType, to, workspaceSlug]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug]);

  return (
    <ResearchListSurface>
      {errorKey && (
        <div className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
          {t(errorKey)}
        </div>
      )}

      <ResearchFilterToolbar>
        <Input
          className="!w-52"
          placeholder={t("research.audit.action_placeholder")}
          value={action}
          onChange={(event) => setAction(event.target.value)}
        />
        <Input
          className="!w-52"
          placeholder={t("research.audit.resource_placeholder")}
          value={resourceType}
          onChange={(event) => setResourceType(event.target.value)}
        />
        <Input type="date" className="!w-40" value={from} onChange={(event) => setFrom(event.target.value)} />
        <Input type="date" className="!w-40" value={to} onChange={(event) => setTo(event.target.value)} />
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          {t("research.common.refresh")}
        </Button>
      </ResearchFilterToolbar>

      <ResearchTableSurface>
        <Table>
          <TableHeader>
            <TableRow className="text-tertiary">
              <TableHead className="text-right">{t("research.audit.columns.time")}</TableHead>
              <TableHead>{t("research.audit.columns.actor")}</TableHead>
              <TableHead>{t("research.audit.columns.action")}</TableHead>
              <TableHead>{t("research.audit.columns.resource")}</TableHead>
              <TableHead>{t("research.audit.columns.metadata")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {events.map((event) => (
              <TableRow key={event.id}>
                <TableCell className="text-right text-tertiary tabular-nums">
                  {new Date(event.created_at).toLocaleString()}
                </TableCell>
                <TableCell className="text-secondary">
                  {event.actor_detail?.display_name ?? event.actor_detail?.email ?? "-"}
                </TableCell>
                <TableCell className="text-secondary">{event.action}</TableCell>
                <TableCell className="text-tertiary">
                  {event.resource_type}
                  {event.org_unit_detail?.name ? ` · ${event.org_unit_detail.name}` : ""}
                </TableCell>
                <TableCell className="max-w-[22rem] truncate text-tertiary">
                  {auditMetadataSummary(event.metadata) || t("research.audit.metadata_omitted")}
                </TableCell>
              </TableRow>
            ))}
            {events.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-tertiary">
                  {t("research.audit.empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ResearchTableSurface>
    </ResearchListSurface>
  );
});
