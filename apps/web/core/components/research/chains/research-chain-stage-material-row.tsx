import { useEffect, useMemo, useState } from "react";

import { useTranslation } from "@plane/i18n";
import type { TResearchChainStageMaterial } from "@plane/types";
import { Button } from "@plane/propel/button";

import { AttachmentPreviewLink } from "@/components/attachments/preview";
import { AttachmentUploadZone } from "@/components/attachments/upload-zone";
import { getResearchErrorKey } from "@/components/research/common/error-messages";
import {
  DEFAULT_RESEARCH_CHAIN_UPLOAD_LIMITS,
  LINKABLE_UPLOAD_STATUSES,
  formatResearchChainFileSize,
  researchChainUploadHintParams,
  researchChainUploadStatusKey,
  type TResearchChainKnowledgeController,
} from "@/components/research/chains/use-research-chain-knowledge";
import { ResearchChainService } from "@/services/research/chain.service";

type Props = {
  workspaceSlug: string;
  chainId: string;
  stageCode: string;
  material: TResearchChainStageMaterial;
  editable: boolean;
  busy: boolean;
  knowledge: TResearchChainKnowledgeController;
  onStageChanged: () => Promise<void> | void;
};

const chainService = new ResearchChainService();

/** Read the only user-facing conclusion for one requirement row. */
function materialStateKey(state: string | undefined): string {
  if (state === "READY") return "research.chains.stage_approval.material_satisfied";
  if (state === "PROCESSING") return "research.chains.stage_approval.material_processing";
  if (state === "FAILED") return "research.chains.stage_approval.material_failed";
  return "research.chains.stage_approval.material_missing";
}

/** Prefer the upstream-degraded explanation when a failure is not a parse rejection. */
function materialFailureKey(material: TResearchChainStageMaterial): string {
  return material.items.some((item) => item.upload_detail?.status === "DEGRADED")
    ? "research.knowledge.upstream_degraded"
    : "research.chains.stage_approval.material_failed";
}

/** Format the elapsed time shown while an upstream parser is still running. */
function processingElapsedText(
  material: TResearchChainStageMaterial,
  processingMeta: TResearchChainKnowledgeController["processingMeta"],
  t: (key: string, params?: Record<string, unknown>) => string,
  now: number
) {
  const metas = material.items
    .map((item) => (item.upload ? processingMeta[item.upload] : undefined))
    .filter((meta): meta is { since: number; lastPolledAt: number } => Boolean(meta));
  if (!metas.length) return t("research.chains.stage_approval.material_processing");
  const seconds = Math.max(0, Math.round((now - Math.min(...metas.map((meta) => meta.since))) / 1000));
  if (seconds >= 300) return t("research.knowledge.processing_timeout", { seconds });
  return t("research.chains.stage_approval.processing_elapsed", { seconds });
}

/** Render one independently uploadable and linkable stage material requirement. */
export function ResearchChainStageMaterialRow({
  workspaceSlug,
  chainId,
  stageCode,
  material,
  editable,
  busy,
  knowledge,
  onStageChanged,
}: Props) {
  const { t } = useTranslation();
  const [selectedUploadId, setSelectedUploadId] = useState("");
  const [rowBusy, setRowBusy] = useState(false);
  const [rowError, setRowError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const processing = material.submission_state === "PROCESSING";
  const failed = material.submission_state === "FAILED";
  const ready = material.submission_state === "READY";

  useEffect(() => {
    if (!processing) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [processing]);

  const linkableUploads = useMemo(
    () => knowledge.uploads.filter((upload) => LINKABLE_UPLOAD_STATUSES.has(upload.status)),
    [knowledge.uploads]
  );
  const linkedUploadIds = useMemo(
    () => new Set(material.items.map((item) => item.upload).filter(Boolean) as string[]),
    [material.items]
  );
  const availableUploads = useMemo(
    () => linkableUploads.filter((upload) => !linkedUploadIds.has(upload.id)),
    [linkableUploads, linkedUploadIds]
  );
  const effectiveUploadId = availableUploads.some((upload) => upload.id === selectedUploadId)
    ? selectedUploadId
    : (availableUploads[0]?.id ?? "");
  const actionBusy = busy || rowBusy;
  const effectiveLimits = knowledge.uploadLimits ?? DEFAULT_RESEARCH_CHAIN_UPLOAD_LIMITS;

  /** Convert one row action error to concise localized text. */
  const describeError = (error: unknown) => {
    const missing = (error as { missing?: unknown } | null | undefined)?.missing;
    if (Array.isArray(missing) && missing.includes(material.code)) {
      return t("research.chains.stage_approval.missing_materials", { materials: material.title });
    }
    return t(getResearchErrorKey(error));
  };

  /** Link one already-uploaded file to this requirement. */
  const addMaterial = async (uploadId: string) => {
    if (!uploadId || actionBusy) return;
    setRowBusy(true);
    setRowError("");
    try {
      await chainService.createChainStageMaterial(workspaceSlug, chainId, stageCode, {
        requirement_code: material.code,
        upload_id: uploadId,
      });
      setSelectedUploadId("");
      await onStageChanged();
    } catch (error) {
      setRowError(describeError(error));
    } finally {
      setRowBusy(false);
    }
  };

  /** Upload one file and immediately retain its processing evidence. */
  const uploadAndLink = async (files: File[]) => {
    if (!knowledge.canUpload || files.length === 0) return;
    setRowBusy(true);
    setRowError("");
    try {
      const created = await knowledge.uploadFiles(files.slice(0, 1));
      const upload = created.find((item) => LINKABLE_UPLOAD_STATUSES.has(item.status));
      if (!upload) return;
      await chainService.createChainStageMaterial(workspaceSlug, chainId, stageCode, {
        requirement_code: material.code,
        upload_id: upload.id,
      });
      setSelectedUploadId("");
      await onStageChanged();
    } catch (error) {
      setRowError(describeError(error));
    } finally {
      setRowBusy(false);
    }
  };

  /** Remove the latest material evidence while the stage remains editable. */
  const removeLastMaterial = async () => {
    const item = material.items[material.items.length - 1];
    if (!item || actionBusy) return;
    setRowBusy(true);
    setRowError("");
    try {
      await chainService.deleteChainStageMaterial(workspaceSlug, chainId, stageCode, item.id);
      await onStageChanged();
    } catch (error) {
      setRowError(describeError(error));
    } finally {
      setRowBusy(false);
    }
  };

  return (
    <li className="py-2.5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="truncate text-13 text-primary" title={material.title}>
            {material.title}
          </p>
          <p className="mt-0.5 text-11 text-tertiary">
            {t("research.chains.stage_approval.material_count", {
              submitted: material.submitted_count,
              required: material.minimum_count,
            })}
            {" · "}
            {t(materialStateKey(material.submission_state))}
          </p>
          {processing && (
            <p className="mt-0.5 text-11 text-secondary" role="status" aria-live="polite">
              {processingElapsedText(material, knowledge.processingMeta, t, now)}
            </p>
          )}
          {failed && (
            <p className="mt-0.5 text-11 text-danger-primary" role="alert">
              {t(materialFailureKey(material))}
            </p>
          )}
        </div>
        {editable && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {!ready && (
              <select
                value={effectiveUploadId}
                onChange={(event) => setSelectedUploadId(event.target.value)}
                aria-label={`${material.title} · ${t("research.chains.stage_approval.select_upload")}`}
                disabled={availableUploads.length === 0 || actionBusy}
                className="max-w-full rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
              >
                {availableUploads.length === 0 ? (
                  <option value="">{t("research.chains.stage_approval.upload_empty")}</option>
                ) : (
                  availableUploads.map((upload) => (
                    <option key={upload.id} value={upload.id}>
                      {upload.file_name} · {formatResearchChainFileSize(upload.file_size)} ·{" "}
                      {t(researchChainUploadStatusKey(upload.status))}
                    </option>
                  ))
                )}
              </select>
            )}
            {!ready && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={actionBusy || !effectiveUploadId}
                onClick={() => void addMaterial(effectiveUploadId)}
              >
                {t("research.chains.stage_approval.link_material")}
              </Button>
            )}
            {material.items.length > 0 && (
              <button
                type="button"
                className="text-11 text-tertiary transition-colors duration-150 hover:text-primary disabled:cursor-default"
                disabled={actionBusy}
                onClick={() => void removeLastMaterial()}
              >
                {t("research.chains.stage_approval.remove_last")}
              </button>
            )}
          </div>
        )}
      </div>

      {material.items.length > 0 && (
        <span className="mt-1 flex min-w-0 flex-col gap-1">
          {material.items.map((item) =>
            item.upload_detail?.preview_url || item.upload_detail?.download_url ? (
              <AttachmentPreviewLink
                key={item.id}
                name={`${item.upload_detail.file_name} · ${formatResearchChainFileSize(item.upload_detail.file_size)} · ${t(
                  researchChainUploadStatusKey(item.upload_detail.status)
                )}`}
                previewUrl={item.upload_detail.preview_url}
                downloadUrl={item.upload_detail.download_url}
                className="truncate text-left text-11 text-secondary hover:text-accent-primary"
              />
            ) : item.upload_detail ? (
              <span key={item.id} className="truncate text-11 text-tertiary" title={item.upload_detail.file_name}>
                {item.upload_detail.file_name} · {t(researchChainUploadStatusKey(item.upload_detail.status))}
                {item.upload_detail.error_code && failed
                  ? ` · ${t("research.knowledge.parse_failed_reason", { reason: item.upload_detail.error_code })}`
                  : ""}
              </span>
            ) : (
              <span key={item.id} className="truncate text-11 text-tertiary" title={item.title}>
                {item.title} · {t("research.chains.stage_approval.historical_text_item")}
              </span>
            )
          )}
        </span>
      )}

      {editable && !ready && (
        <div className="mt-2 space-y-1.5">
          {knowledge.state !== "ready" && knowledge.state !== "degraded" && (
            <p className="text-11 text-secondary">{t("research.chains.stage_approval.upload_unavailable")}</p>
          )}
          {knowledge.actionError && (
            <p className="text-11 text-danger-primary" role="alert">
              {knowledge.actionError}
            </p>
          )}
          {rowError && (
            <p className="text-11 text-danger-primary" role="alert">
              {rowError}
            </p>
          )}
          <AttachmentUploadZone
            onFiles={(files) => void uploadAndLink(files)}
            accept={{
              "application/pdf": [".pdf"],
              "text/markdown": [".md", ".markdown"],
              "text/plain": [".txt"],
              "application/msword": [".doc"],
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
            }}
            maxSize={knowledge.maxUploadSizeBytes ?? Math.max(...Object.values(effectiveLimits)) * 1024 * 1024}
            disabled={!knowledge.canUpload || rowBusy}
            uploading={rowBusy}
            variant="inline"
            title={
              failed
                ? t("research.chains.stage_approval.reupload_material")
                : t("research.chains.stage_approval.material_upload")
            }
            uploadingTitle={t("research.knowledge.uploading")}
            hint={t("research.knowledge.upload_hint", researchChainUploadHintParams(effectiveLimits))}
            inputAriaLabel={`${material.title} · ${
              failed
                ? t("research.chains.stage_approval.reupload_material")
                : t("research.chains.stage_approval.material_upload")
            }`}
          />
        </div>
      )}
    </li>
  );
}
