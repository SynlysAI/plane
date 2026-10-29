/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useId, useState } from "react";
import { Download, FileText, RefreshCw } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { getFileURL } from "@plane/utils";
import { AttachmentUploadZone } from "@/components/attachments/upload-zone";
import { AttachmentPreviewLink } from "@/components/attachments/preview";
import {
  DEFAULT_RESEARCH_CHAIN_UPLOAD_LIMITS,
  formatResearchChainFileSize,
  researchChainUploadHintParams,
  researchChainUploadStatusKey,
  type TResearchChainKnowledgeController,
} from "@/components/research/chains/use-research-chain-knowledge";

const KNOWLEDGE_MATERIAL_ACCEPT = {
  "application/pdf": [".pdf"],
  "text/markdown": [".md", ".markdown"],
  "text/plain": [".txt"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
};

const DEGRADED_REASON_LABELS: Record<string, string> = {
  not_configured: "research.knowledge.reasons.not_configured",
  integration_not_configured: "research.knowledge.reasons.not_configured",
  synlora_not_configured: "research.knowledge.reasons.not_configured",
  unauthorized: "research.knowledge.reasons.unauthorized",
  disabled: "research.knowledge.reasons.disabled",
  connection_disabled: "research.knowledge.reasons.disabled",
  http_error: "research.knowledge.reasons.http_error",
  timeout: "research.knowledge.reasons.timeout",
  transport_error: "research.knowledge.reasons.transport_error",
};

const KB_READY_STATE = "READY";

type Props = {
  knowledge: TResearchChainKnowledgeController;
};

/** Present the shared node material source and its upload state. */
export const ResearchChainKnowledgePanel = function ResearchChainKnowledgePanel({ knowledge }: Props) {
  const { t } = useTranslation();
  const statusId = `${useId().replace(/:/g, "")}-knowledge-upload-status`;
  const {
    uploads,
    state,
    knowledgeBaseId,
    knowledgeState,
    orgUnitName,
    connectionStatus,
    degradedReason,
    actionError,
    uploading,
    canUpload,
    load,
    uploadFiles,
    refreshUpload,
    confirmUpload,
    maxUploadSizeBytes,
    uploadLimits,
  } = knowledge;
  const effectiveUploadLimits = uploadLimits ?? DEFAULT_RESEARCH_CHAIN_UPLOAD_LIMITS;
  const [confirmingUploadIds, setConfirmingUploadIds] = useState<Set<string>>(new Set());
  const [confirmedUploadIds, setConfirmedUploadIds] = useState<Set<string>>(new Set());

  /** Confirm one upload reference and expose a stable result on its row. */
  const confirmReference = async (upload: (typeof uploads)[number]) => {
    setConfirmingUploadIds((current) => new Set(current).add(upload.id));
    try {
      if (await confirmUpload(upload)) {
        setConfirmedUploadIds((current) => new Set(current).add(upload.id));
      }
    } finally {
      setConfirmingUploadIds((current) => {
        const next = new Set(current);
        next.delete(upload.id);
        return next;
      });
    }
  };

  return (
    <section className="border-t border-subtle px-4 py-3" aria-label={t("research.knowledge.materials_title")}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-baseline gap-2 text-13 font-semibold text-primary">
          {t("research.knowledge.materials_title")}
          {state !== "loading" && state !== "idle" && (
            <span className="font-normal text-11 text-tertiary">{uploads.length}</span>
          )}
        </h3>
        {orgUnitName && <span className="text-11 text-tertiary">{orgUnitName}</span>}
      </header>
      {state === "loading" && <p className="mt-2 text-11 text-tertiary">{t("research.knowledge.loading")}</p>}
      {state === "forbidden" && <p className="mt-2 text-11 text-primary">{t("research.common.permission_denied")}</p>}
      {state === "error" && (
        <button type="button" onClick={() => void load()} className="mt-2 text-11 text-accent-primary">
          {t("research.portal.retry")}
        </button>
      )}
      {state === "degraded" && (
        <p className="mt-2 text-11 text-warning-primary">
          {t("research.knowledge.degraded", {
            reason: DEGRADED_REASON_LABELS[degradedReason]
              ? t(DEGRADED_REASON_LABELS[degradedReason])
              : t("research.knowledge.reasons.unknown"),
          })}
        </p>
      )}
      {knowledgeState === "UNASSIGNED" && !["loading", "idle", "forbidden"].includes(state) && (
        <p
          id={connectionStatus === "not_connected" ? undefined : statusId}
          className="mt-2 rounded-md border border-subtle bg-surface-2 px-3 py-2 text-11 text-secondary"
          role="status"
        >
          {t("research.knowledge.unassigned")}
        </p>
      )}
      {knowledgeState !== KB_READY_STATE &&
        knowledgeState !== "UNASSIGNED" &&
        !["loading", "idle", "forbidden"].includes(state) && (
          <p
            id={connectionStatus === "not_connected" ? undefined : statusId}
            className="mt-2 rounded-md border border-subtle bg-surface-2 px-3 py-2 text-11 text-secondary"
            role="status"
          >
            {t(orgUnitName ? "research.knowledge.pending_group" : "research.knowledge.pending_admin", {
              state: knowledgeState,
              team: orgUnitName,
            })}
          </p>
        )}
      {connectionStatus === "not_connected" && !["loading", "idle", "forbidden"].includes(state) && (
        <p id={statusId} className="mt-2 text-11 text-tertiary" role="status">
          {t("research.knowledge.ragportal_not_connected")}
        </p>
      )}
      {actionError && (
        <p className="mt-2 text-11 text-danger-primary" role="alert">
          {actionError}
        </p>
      )}
      {(state === "ready" || state === "degraded") && (
        <>
          {!knowledgeBaseId && knowledgeState === KB_READY_STATE && (
            <p
              id={connectionStatus === "not_connected" ? undefined : statusId}
              className="mt-2 text-11 text-tertiary"
              role="status"
            >
              {t("research.knowledge.no_knowledge_bases")}
            </p>
          )}
          {uploads.length > 0 && (
            <ul className="mt-3 border-t border-subtle" role="list">
              {uploads.map((uploadRecord) => (
                <li key={uploadRecord.id} className="flex flex-wrap items-center gap-2 border-b border-subtle py-2">
                  <FileText className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
                  {uploadRecord.preview_url || uploadRecord.download_url ? (
                    <AttachmentPreviewLink
                      name={`${uploadRecord.file_name} · ${formatResearchChainFileSize(uploadRecord.file_size)}`}
                      previewUrl={uploadRecord.preview_url}
                      downloadUrl={uploadRecord.download_url ?? ""}
                      className="min-w-0 flex-1 text-left text-12 break-all text-primary hover:text-accent-primary"
                    />
                  ) : (
                    <p className="min-w-0 flex-1 text-12 break-all text-primary">
                      {uploadRecord.file_name} · {formatResearchChainFileSize(uploadRecord.file_size)}
                    </p>
                  )}
                  <span className="text-11 text-secondary">{t(researchChainUploadStatusKey(uploadRecord.status))}</span>
                  {uploadRecord.download_url && (
                    <a
                      href={getFileURL(uploadRecord.download_url)}
                      title={t("research.knowledge.download_material")}
                      aria-label={t("research.knowledge.download_material")}
                      onClick={(event) => event.stopPropagation()}
                      className="flex size-7 items-center justify-center rounded-sm text-secondary hover:bg-surface-2 hover:text-primary"
                    >
                      <Download className="size-3.5" aria-hidden="true" />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => void refreshUpload(uploadRecord.id)}
                    title={t("research.knowledge.refresh_status")}
                    aria-label={t("research.knowledge.refresh_status")}
                    className="flex size-7 items-center justify-center rounded-sm text-secondary hover:bg-surface-2"
                  >
                    <RefreshCw className="size-3.5" aria-hidden="true" />
                  </button>
                  {uploadRecord.knowledge_id &&
                    (confirmedUploadIds.has(uploadRecord.id) ? (
                      <span className="px-1 py-1 text-11 text-secondary" role="status" aria-live="polite">
                        {t("research.knowledge.reference_confirmed")}
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={confirmingUploadIds.has(uploadRecord.id)}
                        onClick={() => void confirmReference(uploadRecord)}
                        className="px-1 py-1 text-11 text-secondary hover:text-primary disabled:cursor-wait disabled:opacity-60"
                      >
                        {t(
                          confirmingUploadIds.has(uploadRecord.id)
                            ? "common.confirming"
                            : "research.knowledge.confirm_reference"
                        )}
                      </button>
                    ))}
                </li>
              ))}
            </ul>
          )}
          <AttachmentUploadZone
            onFiles={(files) => void uploadFiles(files)}
            accept={KNOWLEDGE_MATERIAL_ACCEPT}
            multiple
            maxSize={maxUploadSizeBytes ?? Math.max(...Object.values(effectiveUploadLimits)) * 1024 * 1024}
            disabled={!canUpload}
            uploading={uploading}
            variant="compact"
            className="mt-3"
            title={t("research.knowledge.select_material")}
            uploadingTitle={t("research.knowledge.uploading")}
            hint={t("research.knowledge.upload_hint", researchChainUploadHintParams(effectiveUploadLimits))}
          />
        </>
      )}
    </section>
  );
};
