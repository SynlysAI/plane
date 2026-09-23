/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useCallback, useEffect, useState } from "react";
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

  const load = useCallback(async () => {
    setState("loading");
    try {
      const payload = await chainService.getKnowledgeBases(workspaceSlug, chainId);
      setKnowledgeBases(payload.items);
      setKnowledgeBaseId((current) => current || payload.items[0]?.external_id || "");
      setState(payload.degraded ? "degraded" : "ready");
    } catch (error) {
      const errorCode = (error as { error_code?: string })?.error_code;
      setState(errorCode === "research_permission_denied" ? "forbidden" : "error");
    }
  }, [chainId, workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitUpload = async () => {
    if (!file || !knowledgeBaseId || uploading) return;
    setUploading(true);
    setDegradedReason("");
    try {
      const payload = await chainService.uploadKnowledgeFile(workspaceSlug, chainId, nodeId, knowledgeBaseId, file);
      setUploads((current) => [payload.data, ...current.filter((item) => item.id !== payload.data.id)]);
      setState(payload.degraded ? "degraded" : "ready");
      setFile(null);
    } catch (error) {
      const payload = error as { degraded_reason?: string; error_code?: string };
      setDegradedReason(payload.degraded_reason ?? payload.error_code ?? "error");
      setState("degraded");
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
    try {
      await chainService.confirmKnowledgeReference(workspaceSlug, chainId, nodeId, uploadRecord);
      setUploads((current) =>
        current.map((item) => (item.id === uploadRecord.id ? { ...item, status: "SUCCESS" } : item))
      );
    } catch {
      setState("error");
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
            <label className="flex flex-col gap-1 text-11 text-secondary">
              {t("research.knowledge.file_label")}
              <input
                type="file"
                accept=".pdf,.md,.markdown,.txt,.doc,.docx"
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
