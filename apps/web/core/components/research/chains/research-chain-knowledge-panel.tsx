/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useRef, useState } from "react";
// plane imports
import { useTranslation } from "@plane/i18n";
// services
import {
  ResearchChainService,
  type TResearchChainUpload,
  type TResearchKnowledgeBase,
} from "@/services/research/chain.service";

const chainService = new ResearchChainService();

type Props = {
  workspaceSlug: string;
  chainId: string;
  nodeId: string;
};

type TPanelState = "loading" | "ready" | "degraded" | "forbidden" | "error";

const DEGRADED_ERROR_CODES = new Set([
  "UPSTREAM_DEGRADED",
  "upstream_degraded",
  "UPSTREAM_TIMEOUT",
  "upstream_timeout",
]);

/** Upload, poll and confirm scoped RAGPortal knowledge for one node. */
export const ResearchChainKnowledgePanel = function ResearchChainKnowledgePanel({
  workspaceSlug,
  chainId,
  nodeId,
}: Props) {
  const { t } = useTranslation();
  const [knowledgeBases, setKnowledgeBases] = useState<TResearchKnowledgeBase[]>([]);
  const [uploads, setUploads] = useState<TResearchChainUpload[]>([]);
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<TPanelState>("loading");
  const [uploading, setUploading] = useState(false);
  const [degradedReason, setDegradedReason] = useState("");
  const [actionError, setActionError] = useState("");
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
      setKnowledgeBases(payload.items);
      setKnowledgeBaseId((current) => current || payload.items[0]?.external_id || "");
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
    if (!file || !knowledgeBaseId || uploading) return;
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
    <section className="rounded-lg border border-subtle bg-surface-1 p-4">
      <h3 className="text-13 font-medium text-primary">{t("research.knowledge.panel_title")}</h3>
      {state === "loading" && <p className="mt-2 text-11 text-tertiary">{t("research.knowledge.loading")}</p>}
      {state === "forbidden" && <p className="mt-2 text-11 text-primary">{t("research.common.permission_denied")}</p>}
      {state === "error" && (
        <button type="button" onClick={() => void load()} className="mt-2 text-11 text-accent-primary">
          {t("research.portal.retry")}
        </button>
      )}
      {state === "degraded" && (
        <p className="mt-2 text-11 text-warning-primary">
          {t("research.knowledge.degraded", { reason: degradedReason || "unknown" })}
        </p>
      )}
      {actionError && (
        <p className="mt-2 text-11 text-danger-primary" role="alert">
          {actionError}
        </p>
      )}
      {state !== "loading" && state !== "forbidden" && (
        <>
          <div className="mt-3 grid grid-cols-1 gap-2">
            <label className="flex flex-col gap-1 text-11 text-secondary">
              {t("research.knowledge.kb_label")}
              <select
                value={knowledgeBaseId}
                onChange={(event) => setKnowledgeBaseId(event.target.value)}
                className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary"
              >
                {knowledgeBases.map((knowledgeBase) => (
                  <option key={knowledgeBase.external_id} value={knowledgeBase.external_id}>
                    {knowledgeBase.title}
                  </option>
                ))}
              </select>
            </label>
            {knowledgeBases.length === 0 && (
              <p className="text-11 text-tertiary" role="status">
                {t("research.knowledge.no_knowledge_bases")}
              </p>
            )}
            <label className="flex flex-col gap-1 text-11 text-secondary">
              {t("research.knowledge.file_label")}
              <input
                type="file"
                accept=".pdf,.md,.markdown,.txt,.doc,.docx"
                ref={fileInputRef}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="text-11 text-secondary"
              />
            </label>
            <button
              type="button"
              onClick={() => void submitUpload()}
              disabled={!file || !knowledgeBaseId || uploading}
              className="rounded-md bg-accent-primary px-3 py-2 text-12 text-on-color disabled:opacity-50"
            >
              {uploading ? t("research.knowledge.uploading") : t("research.knowledge.upload")}
            </button>
          </div>
          {uploads.length > 0 && (
            <ul className="mt-3 space-y-2" role="list">
              {uploads.map((uploadRecord) => (
                <li key={uploadRecord.id} className="rounded-md border border-subtle p-3">
                  <p className="text-11 font-medium text-primary">{uploadRecord.file_name}</p>
                  <p className="mt-1 text-11 text-tertiary">{uploadRecord.status}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void refresh(uploadRecord.id)}
                      className="rounded border border-subtle px-2 py-1 text-11 text-secondary"
                    >
                      {t("research.knowledge.refresh_status")}
                    </button>
                    {uploadRecord.knowledge_id && (
                      <button
                        type="button"
                        onClick={() => void confirm(uploadRecord)}
                        className="rounded border border-subtle px-2 py-1 text-11 text-secondary"
                      >
                        {t("research.knowledge.confirm_reference")}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
};
