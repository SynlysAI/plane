/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Plus, RefreshCw, Upload, X } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
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
        <p className="mt-2 rounded-md border border-subtle bg-surface-2 px-3 py-2 text-11 text-secondary" role="status">
          {t("research.knowledge.unassigned")}
        </p>
      )}
      {knowledgeState !== KB_READY_STATE &&
        knowledgeState !== "UNASSIGNED" &&
        state !== "loading" &&
        state !== "forbidden" && (
          <p
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
        <p className="mt-2 text-11 text-tertiary" role="status">
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
            <p className="mt-2 text-11 text-tertiary" role="status">
              {t("research.knowledge.no_knowledge_bases")}
            </p>
          )}
          {uploads.length > 0 && (
            <ul className="mt-3 border-t border-subtle" role="list">
              {uploads.map((uploadRecord) => (
                <li key={uploadRecord.id} className="flex flex-wrap items-center gap-2 border-b border-subtle py-2">
                  <FileText className="size-4 shrink-0 text-tertiary" aria-hidden="true" />
                  <p className="min-w-0 flex-1 text-12 break-all text-primary">{uploadRecord.file_name}</p>
                  <span className="text-11 text-secondary">{uploadRecord.status}</span>
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
            disabled={!knowledgeBaseId || knowledgeState !== KB_READY_STATE || uploading}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!knowledgeBaseId || knowledgeState !== KB_READY_STATE || uploading}
              className="inline-flex items-center gap-1 py-2 text-12 text-secondary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t("research.knowledge.add_material")}
            </button>
            {file && (
              <>
                <span className="max-w-full min-w-0 text-12 break-all text-primary" aria-live="polite">
                  {file.name}
                </span>
                <button
                  type="button"
                  disabled={uploading}
                  title={t("research.chain_tasks.cancel_edit")}
                  aria-label={t("research.chain_tasks.cancel_edit")}
                  onClick={() => {
                    setFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                  className="flex size-7 items-center justify-center rounded-sm text-tertiary hover:bg-surface-2 disabled:opacity-50"
                >
                  <X className="size-3.5" aria-hidden="true" />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => void submitUpload()}
              disabled={!file || !knowledgeBaseId || uploading || knowledgeState !== KB_READY_STATE}
              className="inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-12 text-accent-primary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Upload className="size-3.5" aria-hidden="true" />
              {uploading ? t("research.knowledge.uploading") : t("research.knowledge.upload_file")}
            </button>
          </div>
        </>
      )}
    </section>
  );
};
