/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import {
  CODE_PROVIDERS,
  CODE_PROVIDER_LABELS,
  CODE_REF_TYPE_LABELS,
  CODE_REPOSITORY_STATUS_LABELS,
} from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { Button } from "@plane/propel/button";
import { Input } from "@plane/ui";
// components
import { CodeSummaryCard } from "@/components/research/code/code-summary-card";
import { getResearchErrorKey } from "@/components/research/common/error-messages";
import {
  ResearchFilterToolbar,
  ResearchListSurface,
  ResearchTableSurface,
} from "@/components/research/common/research-data-surface";
// hooks
import { useResearch } from "@/hooks/store/use-research";
import { formatResearchDateTime } from "@/components/research/common/research-format";

type Props = {
  workspaceSlug: string;
  projectId: string;
};

/**
 * Repositories, artifacts and snapshots. Plane never hosts Git: this page only
 * registers references and snapshots (P1-CODE-07).
 */
export const CodeRepositoryList = observer(function CodeRepositoryList({ workspaceSlug, projectId }: Props) {
  const { t, currentLocale } = useTranslation();
  const research = useResearch();
  const repositories = research.getCodeRepositories(workspaceSlug, projectId);
  const summary = research.codeSummary[projectId];
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [provider, setProvider] = useState<string>("GITHUB");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [artifactRef, setArtifactRef] = useState("");
  const [refType, setRefType] = useState<string>("COMMIT");
  const [snapshotRef, setSnapshotRef] = useState("");
  const [snapshotFile, setSnapshotFile] = useState<File | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await research.fetchCodeRepositories(workspaceSlug, projectId);
        await research.fetchCodeSummary(workspaceSlug, projectId).catch(() => undefined);
        setSelectedId((current) => current ?? loaded[0]?.id ?? null);
      } catch (error) {
        setErrorKey(getResearchErrorKey(error));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, projectId]);

  useEffect(() => {
    if (!selectedId) return;
    void research.fetchCodeArtifacts(workspaceSlug, selectedId).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, workspaceSlug]);

  const artifacts = selectedId ? (research.codeArtifacts[selectedId] ?? []) : [];
  const selected = repositories.find((repository) => repository.id === selectedId) ?? null;

  return (
    <ResearchListSurface>
      <CodeSummaryCard summary={summary} />
      {errorKey && <p className="text-12 text-danger-primary">{t(errorKey)}</p>}

      <ResearchFilterToolbar>
        <Input
          className="!w-72"
          value={repositoryUrl}
          placeholder={t("research.code.repository_placeholder")}
          onChange={(event) => setRepositoryUrl(event.target.value)}
        />
        <select
          className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
        >
          {CODE_PROVIDERS.map((value) => (
            <option key={value} value={value}>
              {t(CODE_PROVIDER_LABELS[value])}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="primary"
          disabled={!repositoryUrl.trim()}
          onClick={async () => {
            try {
              const repository = await research.createCodeRepository(workspaceSlug, projectId, {
                repository_url: repositoryUrl.trim(),
                provider,
              });
              setRepositoryUrl("");
              setSelectedId(repository.id);
            } catch (error) {
              setErrorKey(getResearchErrorKey(error));
            }
          }}
        >
          {t("research.code.register")}
        </Button>
      </ResearchFilterToolbar>

      <ResearchTableSurface>
        <Table>
          <TableHeader>
            <TableRow className="text-tertiary">
              <TableHead>{t("research.code.columns.repository")}</TableHead>
              <TableHead>{t("research.code.columns.provider")}</TableHead>
              <TableHead>{t("research.code.columns.status")}</TableHead>
              <TableHead>{t("research.code.columns.last_sync")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {repositories.map((repository) => (
              <TableRow
                key={repository.id}
                className={`border-b border-subtle/60 ${repository.id === selectedId ? "bg-surface-2" : ""}`}
              >
                <TableCell className="text-secondary">
                  <button type="button" className="hover:underline" onClick={() => setSelectedId(repository.id)}>
                    {repository.repository_url}
                  </button>
                </TableCell>
                <TableCell className="text-tertiary">{t(CODE_PROVIDER_LABELS[repository.provider])}</TableCell>
                <TableCell>
                  <span
                    className={`rounded px-1.5 py-0.5 text-11 ${
                      repository.status === "ACTIVE"
                        ? "bg-success-subtle text-success-primary"
                        : repository.status === "SYNC_FAILED"
                          ? "bg-danger-subtle text-danger-primary"
                          : "bg-surface-2 text-tertiary"
                    }`}
                  >
                    {t(CODE_REPOSITORY_STATUS_LABELS[repository.status])}
                  </span>
                  {repository.sync_error && <span className="ml-2 text-11 text-tertiary">{repository.sync_error}</span>}
                </TableCell>
                <TableCell className="text-tertiary">
                  {repository.last_sync_at ? formatResearchDateTime(repository.last_sync_at, currentLocale) : "-"}
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void research.syncCodeRepository(workspaceSlug, repository.id)}
                  >
                    {t("research.code.sync")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!repositories.length && (
              <TableRow>
                <TableCell colSpan={5} className="text-tertiary">
                  {t("research.code.empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ResearchTableSurface>

      {selected && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
              value={refType}
              onChange={(event) => setRefType(event.target.value)}
            >
              {(["COMMIT", "BRANCH", "TAG"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(CODE_REF_TYPE_LABELS[value])}
                </option>
              ))}
            </select>
            <Input
              className="!w-64"
              value={artifactRef}
              placeholder={t("research.code.ref_placeholder")}
              onChange={(event) => setArtifactRef(event.target.value)}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!artifactRef.trim()}
              onClick={async () => {
                try {
                  await research.createCodeArtifact(workspaceSlug, selected.id, {
                    ref_type: refType,
                    ref_value: artifactRef.trim(),
                  });
                  setArtifactRef("");
                } catch (error) {
                  setErrorKey(getResearchErrorKey(error));
                }
              }}
            >
              {t("research.code.add_artifact")}
            </Button>
            <Input
              className="!w-32"
              value={snapshotRef}
              placeholder={t("research.code.snapshot_ref")}
              onChange={(event) => setSnapshotRef(event.target.value)}
            />
            <input
              type="file"
              className="text-11 text-secondary"
              onChange={(event) => setSnapshotFile(event.target.files?.[0] ?? null)}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!snapshotFile || !snapshotRef.trim()}
              onClick={async () => {
                if (!snapshotFile) return;
                try {
                  await research.uploadCodeSnapshot(workspaceSlug, selected.id, {
                    file: snapshotFile,
                    ref_value: snapshotRef.trim(),
                  });
                  setSnapshotFile(null);
                  setSnapshotRef("");
                } catch (error) {
                  setErrorKey(getResearchErrorKey(error));
                }
              }}
            >
              {t("research.code.upload_snapshot")}
            </Button>
          </div>

          <ResearchTableSurface>
            <Table>
              <TableHeader>
                <TableRow className="text-tertiary">
                  <TableHead>{t("research.code.columns.ref_type")}</TableHead>
                  <TableHead>{t("research.code.columns.ref_value")}</TableHead>
                  <TableHead>{t("research.code.columns.message")}</TableHead>
                  <TableHead>{t("research.code.columns.experiment")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {artifacts.map((artifact) => (
                  <TableRow key={artifact.id}>
                    <TableCell className="text-tertiary">{t(CODE_REF_TYPE_LABELS[artifact.ref_type])}</TableCell>
                    <TableCell className="text-secondary">{artifact.ref_value}</TableCell>
                    <TableCell className="text-tertiary">{artifact.commit_message || "-"}</TableCell>
                    <TableCell className="text-tertiary">
                      {artifact.linked_experiment ? t("research.code.linked") : "-"}
                    </TableCell>
                  </TableRow>
                ))}
                {!artifacts.length && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-tertiary">
                      {t("research.code.no_artifacts")}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </ResearchTableSurface>
        </div>
      )}
    </ResearchListSurface>
  );
});
