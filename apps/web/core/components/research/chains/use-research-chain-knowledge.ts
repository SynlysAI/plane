import { useCallback, useEffect, useRef, useState } from "react";

import { useTranslation } from "@plane/i18n";
import type { TResearchChainUploadLimits } from "@plane/types";

import { getResearchErrorDetail, getResearchErrorKey } from "@/components/research/common/error-messages";
import { ResearchChainService, type TResearchChainUpload } from "@/services/research/chain.service";

export const LINKABLE_UPLOAD_STATUSES = new Set(["PENDING", "PROCESSING", "SUCCESS"]);
export const DEFAULT_RESEARCH_CHAIN_UPLOAD_LIMITS: TResearchChainUploadLimits = {
  pdf_max_mb: 500,
  markdown_max_mb: 500,
  office_max_mb: 500,
};

export type TResearchChainFileLimit = {
  kind: "PDF" | "MARKDOWN" | "OFFICE";
  label: string;
  maxMb: number;
};

export type TProcessingMeta = {
  since: number;
  lastPolledAt: number;
};

type TPanelState = "idle" | "loading" | "ready" | "degraded" | "forbidden" | "error";
const KB_READY_STATE = "READY";

const DEGRADED_ERROR_CODES = new Set([
  "UPSTREAM_DEGRADED",
  "upstream_degraded",
  "UPSTREAM_TIMEOUT",
  "upstream_timeout",
]);
const PROCESSING_UPLOAD_STATUSES = new Set(["PENDING", "PROCESSING"]);
const TERMINAL_UPLOAD_STATUSES = new Set(["SUCCESS", "FAILED", "DEGRADED"]);
const UPLOAD_POLL_INTERVAL_MS = 5_000;
const UPLOAD_POLL_MAX_MS = 5 * 60_000;
const UPLOAD_POLL_BATCH_SIZE = 5;

const chainService = new ResearchChainService();

export type TResearchChainKnowledgeController = {
  chainId: string;
  nodeId: string;
  uploads: TResearchChainUpload[];
  uploadLimits?: TResearchChainUploadLimits;
  maxUploadSizeBytes?: number;
  state: TPanelState;
  knowledgeBaseId: string;
  knowledgeState: string;
  orgUnitName: string;
  connectionStatus: string;
  degradedReason: string;
  actionError: string;
  uploading: boolean;
  processingMeta: Record<string, TProcessingMeta>;
  canUpload: boolean;
  load: () => Promise<void>;
  uploadFiles: (files: File[]) => Promise<TResearchChainUpload[]>;
  refreshUpload: (uploadId: string) => Promise<void>;
  confirmUpload: (upload: TResearchChainUpload) => Promise<boolean>;
};

/** Resolve the effective client-side limit from a research material filename. */
export function researchChainFileLimitForName(
  fileName: string,
  limits: TResearchChainUploadLimits
): TResearchChainFileLimit | null {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "pdf") return { kind: "PDF", label: "PDF", maxMb: limits.pdf_max_mb };
  if (["md", "markdown", "txt"].includes(extension)) {
    return { kind: "MARKDOWN", label: "Markdown/TXT", maxMb: limits.markdown_max_mb };
  }
  if (["doc", "docx"].includes(extension)) {
    return { kind: "OFFICE", label: "DOC/DOCX", maxMb: limits.office_max_mb };
  }
  return null;
}

/** Build the three type-specific values used by the shared upload hint. */
export function researchChainUploadHintParams(limits: TResearchChainUploadLimits) {
  return {
    pdf: `${limits.pdf_max_mb}MB`,
    markdown: `${limits.markdown_max_mb}MB`,
    office: `${limits.office_max_mb}MB`,
  };
}

/** Read one localized status label key for a scoped research upload. */
export function researchChainUploadStatusKey(status: string): string {
  if (status === "PROCESSING" || status === "PENDING") return "research.knowledge.status_processing";
  if (status === "SUCCESS") return "research.knowledge.status_success";
  if (status === "DEGRADED") return "research.knowledge.status_degraded";
  if (status === "FAILED") return "research.knowledge.status_failed";
  return "research.knowledge.status_unknown";
}

/** Format an upload size without adding visual decoration to the list row. */
export function formatResearchChainFileSize(size: number | undefined): string {
  if (!size || size <= 0) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Load and mutate the node-scoped research material source used by both panels. */
export function useResearchChainKnowledge(
  workspaceSlug: string,
  chainId: string,
  nodeId: string,
  options: { onUploadStatusChanged?: (upload: TResearchChainUpload, previousStatus: string) => void } = {}
): TResearchChainKnowledgeController {
  const { t } = useTranslation();
  const [uploads, setUploads] = useState<TResearchChainUpload[]>([]);
  const [uploadLimits, setUploadLimits] = useState<TResearchChainUploadLimits>(DEFAULT_RESEARCH_CHAIN_UPLOAD_LIMITS);
  const [knowledgeBaseId, setKnowledgeBaseId] = useState("");
  const [state, setState] = useState<TPanelState>("idle");
  const [uploadingCount, setUploadingCount] = useState(0);
  const [degradedReason, setDegradedReason] = useState("");
  const [actionError, setActionError] = useState("");
  const [processingMeta, setProcessingMeta] = useState<Record<string, TProcessingMeta>>({});
  const [knowledgeState, setKnowledgeState] = useState(KB_READY_STATE);
  const [orgUnitName, setOrgUnitName] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("");
  const generationRef = useRef(0);
  const statusCallbackRef = useRef(options.onUploadStatusChanged);
  statusCallbackRef.current = options.onUploadStatusChanged;
  const uploading = uploadingCount > 0;
  const canUpload = Boolean(nodeId && knowledgeBaseId) && knowledgeState === KB_READY_STATE;

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    // A newer scope owns the controller now; an older in-flight upload must not
    // keep the new node marked as busy.
    setUploadingCount(0);
    if (!nodeId) {
      setUploads([]);
      setKnowledgeBaseId("");
      setState("idle");
      return;
    }
    setState("loading");
    try {
      const [payload, uploadPayload] = await Promise.all([
        chainService.getKnowledgeBases(workspaceSlug, chainId),
        chainService.getKnowledgeUploads(workspaceSlug, chainId, nodeId),
      ]);
      if (generationRef.current !== generation) return;
      setKnowledgeState(payload.state ?? KB_READY_STATE);
      setUploadLimits(payload.uploadLimits ?? DEFAULT_RESEARCH_CHAIN_UPLOAD_LIMITS);
      setOrgUnitName(payload.orgUnitName ?? "");
      setConnectionStatus(payload.connectionStatus ?? "");
      setKnowledgeBaseId(payload.items[0]?.external_id ?? "");
      setUploads(uploadPayload.data);
      setProcessingMeta(() => {
        const now = Date.now();
        return Object.fromEntries(
          uploadPayload.data
            .filter((upload) => PROCESSING_UPLOAD_STATUSES.has(upload.status))
            .map((upload) => [upload.id, { since: now, lastPolledAt: 0 }])
        );
      });
      setDegradedReason(payload.degraded_reason ?? "");
      setState(payload.degraded ? "degraded" : "ready");
    } catch (error) {
      if (generationRef.current !== generation) return;
      const errorCode = (error as { error_code?: string })?.error_code;
      setState(errorCode === "research_permission_denied" ? "forbidden" : "error");
    }
  }, [chainId, nodeId, workspaceSlug]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Upload a flattened batch sequentially to preserve order and avoid concurrent RAG calls. */
  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || !nodeId || !knowledgeBaseId || knowledgeState !== KB_READY_STATE) {
        return [];
      }
      const created: TResearchChainUpload[] = [];
      const generation = generationRef.current;
      setUploadingCount((count) => count + 1);
      setDegradedReason("");
      setActionError("");
      let activeFile: File | null = null;
      try {
        for (const file of files) {
          activeFile = file;
          const fileLimit = researchChainFileLimitForName(file.name, uploadLimits);
          if (!fileLimit || file.size > fileLimit.maxMb * 1024 * 1024) {
            setActionError(
              t("research.knowledge.file_too_large", {
                type: fileLimit?.label ?? "Research",
                size: `${fileLimit?.maxMb ?? Math.max(...Object.values(uploadLimits))}MB`,
              })
            );
            break;
          }
          // Sequential uploads deliberately avoid concurrent RAGPortal parsing jobs.
          // oxlint-disable-next-line no-await-in-loop
          const payload = await chainService.uploadKnowledgeFile(workspaceSlug, chainId, nodeId, knowledgeBaseId, file);
          created.push(payload.data);
          if (generationRef.current !== generation) break;
          setUploads((current) => [payload.data, ...current.filter((item) => item.id !== payload.data.id)]);
          if (PROCESSING_UPLOAD_STATUSES.has(payload.data.status)) {
            const observedSince = Date.now();
            setProcessingMeta((current) => ({
              ...current,
              [payload.data.id]: { since: observedSince, lastPolledAt: 0 },
            }));
          }
          setState(payload.degraded ? "degraded" : "ready");
        }
      } catch (error) {
        if (generationRef.current !== generation) return created;
        const payload = error as { degraded_reason?: string; error_code?: string; status?: number };
        const isDegraded = Boolean(payload.degraded_reason) || DEGRADED_ERROR_CODES.has(payload.error_code ?? "");
        if (isDegraded) {
          setDegradedReason(payload.degraded_reason ?? payload.error_code ?? "unknown");
          setState("degraded");
        } else {
          const detail = (error as { error_code?: string }).error_code ? getResearchErrorDetail(error) : null;
          const errorKey = getResearchErrorKey(error);
          const translatedError = errorKey !== "research.errors.generic" ? t(errorKey) : null;
          const fileLimit = researchChainFileLimitForName(activeFile?.name ?? "", uploadLimits);
          setDegradedReason("");
          setActionError(
            payload.status === 413
              ? t("research.knowledge.gateway_too_large", {
                  type: fileLimit?.label ?? "Research",
                  size: `${fileLimit?.maxMb ?? Math.max(...Object.values(uploadLimits))}MB`,
                })
              : (translatedError ?? detail ?? t("research.knowledge.action_failed"))
          );
          setState(payload.error_code === "research_permission_denied" ? "forbidden" : "ready");
        }
      } finally {
        setUploadingCount((count) => Math.max(0, count - 1));
      }
      return created;
    },
    [chainId, knowledgeBaseId, knowledgeState, nodeId, t, uploadLimits, workspaceSlug]
  );

  const refreshUpload = useCallback(
    async (uploadId: string) => {
      const generation = generationRef.current;
      try {
        const payload = await chainService.getKnowledgeUpload(workspaceSlug, chainId, uploadId);
        if (generationRef.current !== generation) return;
        const previous = uploads.find((item) => item.id === uploadId);
        if (previous && previous.status !== payload.data.status) {
          statusCallbackRef.current?.(payload.data, previous.status);
        }
        setUploads((current) => current.map((item) => (item.id === uploadId ? payload.data : item)));
        if (TERMINAL_UPLOAD_STATUSES.has(payload.data.status)) {
          setProcessingMeta((current) => {
            const next = { ...current };
            delete next[uploadId];
            return next;
          });
        } else if (PROCESSING_UPLOAD_STATUSES.has(payload.data.status)) {
          setProcessingMeta((current) => ({
            ...current,
            [uploadId]: current[uploadId] ?? { since: Date.now(), lastPolledAt: 0 },
          }));
        }
        setState(payload.degraded ? "degraded" : "ready");
      } catch {
        setState("degraded");
      }
    },
    [chainId, uploads, workspaceSlug]
  );

  const confirmUpload = useCallback(
    async (upload: TResearchChainUpload): Promise<boolean> => {
      if (!nodeId) return false;
      const generation = generationRef.current;
      setActionError("");
      try {
        await chainService.confirmKnowledgeReference(workspaceSlug, chainId, nodeId, upload);
        if (generationRef.current !== generation) return false;
        setUploads((current) => current.map((item) => (item.id === upload.id ? { ...item, status: "SUCCESS" } : item)));
        return true;
      } catch (error) {
        if (generationRef.current !== generation) return false;
        const detail = (error as { error_code?: string }).error_code ? getResearchErrorDetail(error) : null;
        setActionError(detail ?? t("research.knowledge.action_failed"));
        return false;
      }
    },
    [chainId, nodeId, t, workspaceSlug]
  );

  /** Poll the oldest processing uploads in bounded, sequential detail requests. */
  const pollProcessingUploads = useCallback(async () => {
    if (typeof document === "undefined" || document.visibilityState !== "visible" || uploading) return;
    const now = Date.now();
    const candidates = Object.entries(processingMeta)
      .filter(([, meta]) => now - meta.since < UPLOAD_POLL_MAX_MS)
      // oxlint-disable-next-line eslint-plugin-unicorn/no-array-sort -- Object.entries copies the source before sorting.
      .sort((left, right) => left[1].lastPolledAt - right[1].lastPolledAt)
      .slice(0, UPLOAD_POLL_BATCH_SIZE)
      .map(([uploadId]) => uploadId);
    if (candidates.length === 0) return;
    setProcessingMeta((current) => {
      const next = { ...current };
      for (const uploadId of candidates) {
        if (next[uploadId]) next[uploadId] = { ...next[uploadId], lastPolledAt: Date.now() };
      }
      return next;
    });
    for (const uploadId of candidates) {
      // oxlint-disable-next-line no-await-in-loop
      await refreshUpload(uploadId);
    }
  }, [processingMeta, refreshUpload, uploading]);

  useEffect(() => {
    const timer = window.setInterval(() => void pollProcessingUploads(), UPLOAD_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [pollProcessingUploads]);

  return {
    chainId,
    nodeId,
    uploads,
    uploadLimits,
    maxUploadSizeBytes: Math.max(...Object.values(uploadLimits)) * 1024 * 1024,
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
  };
}
