/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { OUTCOME_STATUSES, OUTCOME_STATUS_LABELS, OUTCOME_TYPES, OUTCOME_TYPE_LABELS } from "@plane/constants";
import type { TOutcomeType } from "@plane/constants";
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
// components
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
// hooks
import { useResearch } from "@/hooks/store/use-research";
import { ResearchOutcomeService } from "@/services/research/outcome.service";

const outcomeService = new ResearchOutcomeService();

type Props = {
  workspaceSlug: string;
  projectId: string;
};

/** Outcomes page: register results and link them back into the chain (P1-FIN-02). */
export const OutcomeList = observer(function OutcomeList({ workspaceSlug, projectId }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const outcomes = research.getOutcomes(workspaceSlug, projectId);
  const [title, setTitle] = useState("");
  const [outputType, setOutputType] = useState<TOutcomeType>("PAPER");
  const [venue, setVenue] = useState("");
  const [doi, setDoi] = useState("");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [uploadingOutcomeId, setUploadingOutcomeId] = useState<string | null>(null);
  const outcomeFileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void research.fetchOutcomes(workspaceSlug, projectId).catch((error) => setErrorKey(getResearchErrorKey(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, projectId]);

  return (
    <ResearchListSurface>
      <ResearchFilterToolbar>
        <Input
          className="!w-64"
          value={title}
          placeholder={t("research.outcomes.title_placeholder")}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Input
          className="!w-44"
          value={venue}
          placeholder={t("research.outcomes.venue_placeholder")}
          onChange={(event) => setVenue(event.target.value)}
        />
        <Input
          className="!w-40"
          value={doi}
          placeholder={t("research.outcomes.doi_placeholder")}
          onChange={(event) => setDoi(event.target.value)}
        />
        <select
          className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
          value={outputType}
          onChange={(event) => setOutputType(event.target.value as TOutcomeType)}
        >
          {OUTCOME_TYPES.map((value) => (
            <option key={value} value={value}>
              {t(OUTCOME_TYPE_LABELS[value])}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="primary"
          disabled={!title.trim()}
          onClick={async () => {
            try {
              await research.createOutcome(workspaceSlug, projectId, {
                title: title.trim(),
                output_type: outputType,
                venue: venue.trim(),
                doi: doi.trim(),
              });
              setTitle("");
              setVenue("");
              setDoi("");
            } catch (error) {
              setErrorKey(getResearchErrorKey(error));
            }
          }}
        >
          {t("research.outcomes.register")}
        </Button>
        <a
          className="ml-auto text-12 text-accent-primary hover:underline"
          href={research.chainExportUrl(workspaceSlug, projectId)}
          target="_blank"
          rel="noreferrer"
        >
          {t("research.outcomes.export_chain")}
        </a>
      </ResearchFilterToolbar>

      {errorKey && <p className="text-12 text-danger-primary">{t(errorKey)}</p>}

      <ResearchTableSurface>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("research.outcomes.columns.title")}</TableHead>
              <TableHead>{t("research.outcomes.columns.type")}</TableHead>
              <TableHead>{t("research.outcomes.columns.venue")}</TableHead>
              <TableHead>{t("research.outcomes.columns.status")}</TableHead>
              <TableHead className="text-right">{t("research.outcomes.columns.links")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {outcomes.map((outcome) => (
              <TableRow key={outcome.id} className="hover:bg-surface-2">
                <TableCell className="font-medium text-primary">{outcome.title}</TableCell>
                <TableCell className="text-tertiary">{t(OUTCOME_TYPE_LABELS[outcome.output_type])}</TableCell>
                <TableCell className="text-tertiary">{outcome.venue || outcome.doi || "-"}</TableCell>
                <TableCell>
                  <select
                    className="rounded border border-subtle bg-surface-1 px-1 py-0.5 text-11 text-secondary"
                    value={outcome.status}
                    onChange={(event) =>
                      void research
                        .updateOutcome(workspaceSlug, outcome.id, { status: event.target.value })
                        .catch(() => undefined)
                    }
                  >
                    {OUTCOME_STATUSES.map((value) => (
                      <option key={value} value={value}>
                        {t(OUTCOME_STATUS_LABELS[value])}
                      </option>
                    ))}
                  </select>
                  <ResearchStatusBadge status={outcome.status} size="sm" className="ml-2">
                    {t(OUTCOME_STATUS_LABELS[outcome.status])}
                  </ResearchStatusBadge>
                </TableCell>
                <TableCell className="text-right text-tertiary tabular-nums">
                  <button
                    type="button"
                    className="mr-3 text-12 text-accent-primary hover:underline disabled:opacity-50"
                    disabled={outcome.status !== "DRAFT" || uploadingOutcomeId === outcome.id}
                    onClick={() => {
                      setUploadingOutcomeId(outcome.id);
                      outcomeFileRef.current?.click();
                    }}
                  >
                    {uploadingOutcomeId === outcome.id
                      ? t("research.outcomes.uploading")
                      : t("research.outcomes.upload_file")}
                  </button>
                  {outcome.links?.length ?? 0}
                </TableCell>
              </TableRow>
            ))}
            {!outcomes.length && (
              <TableRow>
                <TableCell colSpan={5} className="py-3 text-tertiary">
                  {t("research.outcomes.empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ResearchTableSurface>
      <input
        ref={outcomeFileRef}
        type="file"
        accept=".pdf,.md,.markdown,application/pdf,text/markdown"
        className="hidden"
        onChange={async (event) => {
          const file = event.target.files?.[0];
          const outcomeId = uploadingOutcomeId;
          event.target.value = "";
          if (!file || !outcomeId) return;
          try {
            const presigned = await outcomeService.presignOutcomeAttachment(workspaceSlug, outcomeId, {
              file_name: file.name,
              content_type: file.type || "application/octet-stream",
              size: file.size,
            });
            const form = new FormData();
            Object.entries(presigned.upload_data.fields).forEach(([key, value]) => form.append(key, value));
            form.append("file", file);
            const response = await fetch(presigned.upload_data.url, { method: "POST", body: form });
            if (!response.ok) throw new Error("upload_failed");
            await outcomeService.registerOutcomeAttachment(workspaceSlug, outcomeId, presigned.asset_id);
          } catch (error) {
            setErrorKey(getResearchErrorKey(error));
          } finally {
            setUploadingOutcomeId(null);
          }
        }}
      />
      <p className="text-11 text-tertiary">{t("research.outcomes.link_hint")}</p>
    </ResearchListSurface>
  );
});
