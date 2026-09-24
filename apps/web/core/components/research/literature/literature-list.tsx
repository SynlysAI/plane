/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { LITERATURE_STATUSES, LITERATURE_STATUS_LABELS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { Input } from "@plane/ui";
// components
import { LiteratureForm } from "@/components/research/literature/literature-form";
import { LiteratureImportDialog } from "@/components/research/literature/literature-import-dialog";
import { LiteratureStatusBoard } from "@/components/research/literature/literature-status-board";
import { LiteratureThresholdPanel } from "@/components/research/literature/literature-threshold-panel";
// components
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
  projectId: string;
};

/** Literature page: filters, status board, threshold panel and entries (§6.2). */
export const LiteratureList = observer(function LiteratureList({ workspaceSlug, projectId }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const [status, setStatus] = useState("");
  const [query, setQuery] = useState("");
  const entries = research.getLiterature(workspaceSlug, projectId);
  const threshold = research.literatureThreshold[projectId];

  useEffect(() => {
    void research
      .fetchLiterature(workspaceSlug, projectId, { status: status || undefined, q: query || undefined })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, projectId, status]);

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-5">
      <LiteratureThresholdPanel threshold={threshold} />
      <div className="flex flex-wrap items-center gap-2">
        <LiteratureStatusBoard counters={threshold?.counters} active={status} onSelect={(value) => setStatus(value)} />
        <Input
          className="!w-56"
          value={query}
          placeholder={t("research.literature.search_placeholder")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter")
              void research
                .fetchLiterature(workspaceSlug, projectId, { status: status || undefined, q: query || undefined })
                .catch(() => undefined);
          }}
        />
        <LiteratureImportDialog onImport={(payload) => research.importLiterature(workspaceSlug, projectId, payload)} />
      </div>

      <LiteratureForm
        onCreate={async (payload) => {
          await research.createLiterature(workspaceSlug, projectId, payload);
          await research.fetchLiterature(workspaceSlug, projectId, { status: status || undefined });
        }}
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("research.literature.columns.title")}</TableHead>
            <TableHead>{t("research.literature.columns.year")}</TableHead>
            <TableHead>{t("research.literature.columns.venue")}</TableHead>
            <TableHead>{t("research.literature.columns.doi")}</TableHead>
            <TableHead>{t("research.literature.columns.status")}</TableHead>
            <TableHead className="text-right">{t("research.approvals.columns.actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow key={entry.id} className="hover:bg-surface-2">
              <TableCell className="font-medium text-primary">
                {entry.title}
                {!entry.is_annotated && (
                  <span className="ml-2 text-11 text-warning-primary">{t("research.literature.needs_notes")}</span>
                )}
              </TableCell>
              <TableCell className="text-tertiary">{entry.year ?? "-"}</TableCell>
              <TableCell className="text-tertiary">{entry.venue || "-"}</TableCell>
              <TableCell className="text-tertiary">{entry.doi || "-"}</TableCell>
              <TableCell>
                <ResearchStatusBadge status={entry.status} size="sm">
                  {t(LITERATURE_STATUS_LABELS[entry.status])}
                </ResearchStatusBadge>
              </TableCell>
              <TableCell className="text-right">
                <select
                  className="rounded border border-subtle bg-surface-1 px-1 py-0.5 text-11 text-secondary"
                  value={entry.status}
                  onChange={(event) =>
                    void research
                      .updateLiteratureStatus(workspaceSlug, entry.id, { status: event.target.value })
                      .catch(() => undefined)
                  }
                >
                  {LITERATURE_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {t(LITERATURE_STATUS_LABELS[value])}
                    </option>
                  ))}
                </select>
              </TableCell>
            </TableRow>
          ))}
          {!entries.length && (
            <TableRow>
              <TableCell colSpan={6} className="py-3 text-tertiary">
                {t("research.literature.empty")}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
});
