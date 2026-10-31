/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useId, useState } from "react";
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
    processingMeta,
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
  const processingUploads = uploads.filter((upload) => upload.status === "PENDING" || upload.status === "PROCESSING");
  const [now, setNow] = useState(() => Date.now());
  const processingSeconds = (uploadId: string) =>
    Math.max(0, Math.round((now - (processingMeta[uploadId]?.since ?? now)) / 1000));
  const readinessNotice = (() => {
    if (["loading", "idle", "forbidden"].includes(state)) return null;
    if (knowledgeState === "UNASSIGNED") return { key: "research.knowledge.unassigned", boxed: true };
    if (knowledgeState !== KB_READY_STATE) {
      return {
        key: orgUnitName ? "research.knowledge.pending_group" : "research.knowledge.pending_admin",
        params: { state: knowledgeState, team: orgUnitName },
        boxed: true,
      };
    }
    if (state === "degraded") {
      return {
        key: "research.knowledge.degraded",
        params: {
          reason: DEGRADED_REASON_LABELS[degradedReason]
            ? t(DEGRADED_REASON_LABELS[degradedReason])
            : t("research.knowledge.reasons.unknown"),
        },
        boxed: false,
      };
    }
    if (!knowledgeBaseId) return { key: "research.knowledge.no_knowledge_bases", boxed: false };
    if (connectionStatus === "not_connected") {
      return { key: "research.knowledge.ragportal_not_connected", boxed: false };
    }
    return null;
  })();

  useEffect(() => {
    if (processingUploads.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [processingUploads.length]);

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
      {readinessNotice && (
        <p
          id={statusId}
          className={
            readinessNotice.boxed
              ? "mt-2 rounded-md border border-subtle bg-surface-2 px-3 py-2 text-11 text-secondary"
              : "mt-2 text-11 text-tertiary"
          }
          role="status"
        >
          {t(readinessNotice.key, readinessNotice.params)}
        </p>
      )}
      {actionError && (
        <p className="mt-2 text-11 text-danger-primary" role="alert">
          {actionError}
        </p>
      )}
      {(state === "ready" || state === "degraded") && (
        <>
          {uploads.length > 0 && (
            <ul className="mt-3 border-t border-subtle" role="list">
              {uploads.map((uploadRecord) => (
                <li key={uploadRecord.id} className="flex flex-wrap items-center gap-2 border-b border-subtle py-2">
                  <FileText className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
                  {uploadRecord.preview_url || uploadRecord.download_url ? (
                    <AttachmentPreviewLink
                      name={`${uploadRecord.file_name} · ${formatResearchChainFileSize(uploadRecord.file_size)}`}
                      title={uploadRecord.file_name}
                      previewUrl={uploadRecord.preview_url}
                      downloadUrl={uploadRecord.download_url ?? ""}
                      className="block w-full min-w-0 flex-1 basis-full truncate text-left text-12 text-primary hover:text-accent-primary sm:w-auto sm:basis-auto"
                    />
                  ) : (
                    <p
                      className="w-full min-w-0 flex-1 basis-full truncate text-12 text-primary sm:w-auto sm:basis-auto"
                      title={uploadRecord.file_name}
                    >
                      {uploadRecord.file_name} · {formatResearchChainFileSize(uploadRecord.file_size)}
                    </p>
                  )}
                  <span className="text-11 text-secondary" role="status">
                    {uploadRecord.status === "PENDING" || uploadRecord.status === "PROCESSING"
                      ? processingSeconds(uploadRecord.id) >= 300
                        ? t("research.knowledge.processing_timeout", { seconds: processingSeconds(uploadRecord.id) })
                        : t("research.knowledge.processing_elapsed", { seconds: processingSeconds(uploadRecord.id) })
                      : uploadRecord.status === "DEGRADED"
                        ? t("research.knowledge.upstream_degraded")
                        : uploadRecord.status === "FAILED"
                          ? t("research.knowledge.parse_failed_reason", {
                              reason: uploadRecord.error_code || t("research.common.status_unknown"),
                            })
                          : t(researchChainUploadStatusKey(uploadRecord.status))}
                  </span>
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
                  {(uploadRecord.status === "FAILED" || uploadRecord.status === "DEGRADED") && (
                    <AttachmentUploadZone
                      onFiles={(files) => void uploadFiles(files.slice(0, 1))}
                      accept={KNOWLEDGE_MATERIAL_ACCEPT}
                      maxSize={maxUploadSizeBytes ?? Math.max(...Object.values(effectiveUploadLimits)) * 1024 * 1024}
                      disabled={!canUpload || uploading}
                      uploading={uploading}
                      variant="inline"
                      title={t("research.knowledge.retry_upload")}
                      uploadingTitle={t("research.knowledge.uploading")}
                      inputAriaLabel={t("research.knowledge.retry_upload")}
                    />
                  )}
                  {uploadRecord.knowledge_id &&
                    (confirmedUploadIds.has(uploadRecord.id) ? (
                      <span className="px-1 py-1 text-11 text-secondary" role="status" aria-live="polite">
                        {t("research.knowledge.reference_confirmed")}
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={confirmingUploadIds.has(uploadRecord.id) || uploadRecord.status !== "SUCCESS"}
                        aria-describedby={
                          uploadRecord.status === "SUCCESS"
                            ? undefined
                            : `${statusId}-${uploadRecord.id}-confirm-reason`
                        }
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
                  {uploadRecord.status !== "SUCCESS" && uploadRecord.knowledge_id && (
                    <span id={`${statusId}-${uploadRecord.id}-confirm-reason`} className="w-full text-11 text-tertiary">
                      {uploadRecord.status === "FAILED"
                        ? t("research.knowledge.parse_failed_reason", {
                            reason: uploadRecord.error_code || t("research.common.status_unknown"),
                          })
                        : uploadRecord.status === "DEGRADED"
                          ? t("research.knowledge.upstream_degraded")
                          : t("research.knowledge.waiting_for_parse")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <AttachmentUploadZone
            onFiles={(files) => void uploadFiles(files)}
            accept={KNOWLEDGE_MATERIAL_ACCEPT}
            multiple
            maxSize={maxUploadSizeBytes ?? Math.max(...Object.values(effectiveUploadLimits)) * 1024 * 1024}
            disabled={!canUpload || uploading}
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
