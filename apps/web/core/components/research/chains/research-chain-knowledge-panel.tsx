/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Download, FileText, Plus, RefreshCw, Upload } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { getFileURL } from "@plane/utils";
import { AttachmentPreviewLink } from "@/components/attachments/preview";
// services
import { ResearchChainService, type TResearchChainUpload } from "@/services/research/chain.service";

const chainService = new ResearchChainService();

type Props = {
  workspaceSlug: string;
  chainId: string;
  nodeId: string;
};

type TPanelState = "loading" | "ready" | "degraded" | "forbidden" | "error";
const KB_READY_STATE = "READY";

const DEGRADED_ERROR_CODES = new Set([
  "UPSTREAM_DEGRADED",
  "upstream_degraded",
  "UPSTREAM_TIMEOUT",
  "upstream_timeout",
]);

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

/** 以克制的文本形式展示上传文件大小。 */
function formatFileSize(size: number | undefined): string {
  if (!size || size <= 0) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Upload, poll and confirm scoped RAGPortal knowledge for one node. */
export const ResearchChainKnowledgePanel = function ResearchChainKnowledgePanel({
  workspaceSlug,
  chainId,
  nodeId,
}: Props) {
  const { t } = useTranslation();
  const [uploads, setUploads] = useState<TResearchChainUpload[]>([]);
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<TPanelState>("loading");
  const [uploading, setUploading] = useState(false);
  const [degradedReason, setDegradedReason] = useState("");
  const [actionError, setActionError] = useState("");
  const [knowledgeState, setKnowledgeState] = useState(KB_READY_STATE);
  const [orgUnitName, setOrgUnitName] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const statusId = `${useId().replace(/:/g, "")}-knowledge-upload-status`;
  const canSelectFile = Boolean(knowledgeBaseId) && knowledgeState === KB_READY_STATE && !uploading;

  const load = useCallback(async () => {
    setState("loading");
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    try {
      const [payload, uploadPayload] = await Promise.all([
        chainService.getKnowledgeBases(workspaceSlug, chainId),
        chainService.getKnowledgeUploads(workspaceSlug, chainId, nodeId),
      ]);
      setKnowledgeState(payload.state ?? KB_READY_STATE);
      setOrgUnitName(payload.orgUnitName ?? "");
      setConnectionStatus(payload.connectionStatus ?? "");
      setKnowledgeBaseId(payload.items[0]?.external_id ?? "");
      setUploads(uploadPayload.data);
      setDegradedReason(payload.degraded_reason ?? "");
      setState(payload.degraded ? "degraded" : "ready");
    } catch (error) {
      const errorCode = (error as { error_code?: string })?.error_code;
      setState(errorCode === "research_permission_denied" ? "forbidden" : "error");
    }
  }, [chainId, nodeId, workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitUpload = async () => {
    if (!file || !knowledgeBaseId || uploading || knowledgeState !== KB_READY_STATE) return;
    setUploading(true);
    setDegradedReason("");
    setActionError("");
    try {
      const payload = await chainService.uploadKnowledgeFile(workspaceSlug, chainId, nodeId, knowledgeBaseId, file);
      setUploads((current) => [payload.data, ...current.filter((item) => item.id !== payload.data.id)]);
      setState(payload.degraded ? "degraded" : "ready");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (error) {
      const payload = error as { degraded_reason?: string; error_code?: string };
      const isDegraded = Boolean(payload.degraded_reason) || DEGRADED_ERROR_CODES.has(payload.error_code ?? "");
      if (isDegraded) {
        setDegradedReason(payload.degraded_reason ?? payload.error_code ?? "unknown");
        setState("degraded");
      } else {
        setDegradedReason("");
        setActionError(t("research.knowledge.action_failed"));
        setState(payload.error_code === "research_permission_denied" ? "forbidden" : "ready");
      }
    } finally {
      setUploading(false);
    }
  };

  const refresh = async (uploadId: string) => {
    try {
      const payload = await chainService.getKnowledgeUpload(workspaceSlug, chainId, uploadId);
      setUploads((current) => current.map((item) => (item.id === uploadId ? payload.data : item)));
      setState(payload.degraded ? "degraded" : "ready");
    } catch {
      setState("degraded");
    }
  };

  const confirm = async (uploadRecord: TResearchChainUpload) => {
    setActionError("");
    try {
      await chainService.confirmKnowledgeReference(workspaceSlug, chainId, nodeId, uploadRecord);
      setUploads((current) =>
        current.map((item) => (item.id === uploadRecord.id ? { ...item, status: "SUCCESS" } : item))
      );
    } catch {
      setActionError(t("research.knowledge.action_failed"));
    }
  };

  return (
    <section className="border-t border-subtle px-4 py-3" aria-label={t("research.knowledge.materials_title")}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-baseline gap-2 text-13 font-semibold text-primary">
          {t("research.knowledge.materials_title")}
          {state !== "loading" && <span className="font-normal text-11 text-tertiary">{uploads.length}</span>}
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
      {knowledgeState === "UNASSIGNED" && state !== "loading" && state !== "forbidden" && (
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
        state !== "loading" &&
        state !== "forbidden" && (
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
      {connectionStatus === "not_connected" && state !== "loading" && state !== "forbidden" && (
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
                      name={uploadRecord.file_name}
                      previewUrl={uploadRecord.preview_url}
                      downloadUrl={uploadRecord.download_url ?? ""}
                      className="min-w-0 flex-1 text-left text-12 break-all text-primary hover:text-accent-primary"
                    />
                  ) : (
                    <p className="min-w-0 flex-1 text-12 break-all text-primary">{uploadRecord.file_name}</p>
                  )}
                  <span className="text-11 text-secondary">{uploadRecord.status}</span>
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
                    onClick={() => void refresh(uploadRecord.id)}
                    title={t("research.knowledge.refresh_status")}
                    aria-label={t("research.knowledge.refresh_status")}
                    className="flex size-7 items-center justify-center rounded-sm text-secondary hover:bg-surface-2"
                  >
                    <RefreshCw className="size-3.5" aria-hidden="true" />
                  </button>
                  {uploadRecord.knowledge_id && (
                    <button
                      type="button"
                      onClick={() => void confirm(uploadRecord)}
                      className="px-1 py-1 text-11 text-secondary hover:text-primary"
                    >
                      {t("research.knowledge.confirm_reference")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <input
            type="file"
            accept=".pdf,.md,.markdown,.txt,.doc,.docx"
            aria-label={t("research.knowledge.select_file")}
            ref={fileInputRef}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="hidden"
            disabled={!canSelectFile}
          />
          {!file ? (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!canSelectFile}
              aria-describedby={statusId}
              className="inline-flex items-center gap-1.5 rounded bg-accent-primary px-2.5 py-1.5 text-12 text-on-color disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t("research.knowledge.select_material")}
            </button>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-subtle pt-2">
              <span className="max-w-full min-w-0 text-12 break-all text-primary" aria-live="polite">
                {file.name}
                <span className="ml-2 whitespace-nowrap text-tertiary">{formatFileSize(file.size)}</span>
              </span>
              <button
                type="button"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
                className="rounded border border-subtle px-2 py-1 text-12 text-secondary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("research.knowledge.reselect_file")}
              </button>
              <button
                type="button"
                onClick={() => void submitUpload()}
                disabled={uploading}
                className="inline-flex items-center gap-1.5 rounded bg-accent-primary px-2.5 py-1 text-12 text-on-color disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Upload className="size-3.5" aria-hidden="true" />
                {uploading ? t("research.knowledge.uploading") : t("research.knowledge.start_upload")}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
};
