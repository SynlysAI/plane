/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useRef, useState } from "react";

import { useTranslation } from "@plane/i18n";
import type { TResearchChainNode, TResearchChainStageApproval, TResearchChainStageReviewAction } from "@plane/types";
import { Button } from "@plane/propel/button";

import { AttachmentPreviewLink } from "@/components/attachments/preview";
import { AttachmentUploadZone } from "@/components/attachments/upload-zone";
import { ResearchChainService } from "@/services/research/chain.service";
import { formatResearchDateTime } from "@/components/research/common/research-format";
import { getResearchErrorDetail } from "@/components/research/common/error-messages";
import {
  DEFAULT_RESEARCH_CHAIN_UPLOAD_LIMITS,
  LINKABLE_UPLOAD_STATUSES,
  formatResearchChainFileSize,
  researchChainUploadHintParams,
  researchChainUploadStatusKey,
  type TResearchChainKnowledgeController,
} from "@/components/research/chains/use-research-chain-knowledge";

type Props = {
  workspaceSlug: string;
  chainId: string;
  stage: TResearchChainStageApproval;
  nodes: TResearchChainNode[];
  preferredNodeId: string | null;
  applicantName?: string | null;
  defaultExpanded?: boolean;
  knowledge: TResearchChainKnowledgeController;
  onCreateNode?: () => void;
  onChanged: () => Promise<void> | void;
  /** 审批或退回成功后通知队列层，仅由动作结果触发。 */
  onDecision?: (stage: TResearchChainStageApproval) => Promise<void> | void;
};

type TReviewIntent = "APPROVE" | "RETURN";

const SUBMITTABLE_NODE_STATUSES = new Set(["DRAFT", "ACTIVE", "NEEDS_REVISION"]);
const chainService = new ResearchChainService();

/** 将固定阶段码映射到现有业务节点类型。 */
function nodeTypeForStage(stageCode: string): string {
  if (stageCode === "ANALYSIS_PRE_EXPERIMENT" || stageCode === "ANALYSIS_EXPERIMENT") return "ANALYSIS";
  return stageCode;
}

/** 按父级链路区分两个分析阶段，避免选错提交节点。 */
function nodeMatchesStage(node: TResearchChainNode, nodes: TResearchChainNode[], stageCode: string): boolean {
  if (stageCode !== "ANALYSIS_PRE_EXPERIMENT" && stageCode !== "ANALYSIS_EXPERIMENT") {
    return node.node_type === nodeTypeForStage(stageCode);
  }
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const ancestorTypes = new Set<string>();
  let parentId = node.parent_node;
  while (parentId) {
    const parent = byId.get(parentId);
    if (!parent) break;
    ancestorTypes.add(parent.node_type);
    parentId = parent.parent_node;
  }
  if (stageCode === "ANALYSIS_EXPERIMENT") {
    return ancestorTypes.has("EXPERIMENT") || ancestorTypes.has("ITERATION");
  }
  return ancestorTypes.has("PRE_EXPERIMENT");
}

/** 读取当前用户可执行的阶段操作。 */
function can(stage: TResearchChainStageApproval, action: string): boolean {
  return stage.capabilities?.actions[action]?.allowed ?? false;
}

/** 生成折叠摘要中的当前动作文案键。 */
function actionKey(stage: TResearchChainStageApproval, hasSubmittableNode: boolean): string {
  if (stage.status === "AWAITING_ADVISOR") return "research.chains.stage_approval.action_await_advisor";
  if (stage.status === "AWAITING_PI") return "research.chains.stage_approval.action_await_pi";
  if (stage.status === "NEEDS_REVISION") return "research.chains.stage_approval.action_needs_revision";
  if (stage.status === "APPROVED") return "research.chains.stage_approval.action_approved";
  if (!hasSubmittableNode) return "research.chains.stage_approval.action_create_node";
  return "research.chains.stage_approval.action_submit";
}

/** 将后端阶段码映射到十三阶段地图的本地化名称。 */
function stageLabelKey(stageCode: string): string {
  return `research.chains.workflow.stages.${stageCode.toLowerCase()}`;
}

/** 读取最新一次退回意见。 */
function latestReturn(stage: TResearchChainStageApproval): TResearchChainStageReviewAction | null {
  return reverseReviewActions(stage.review_actions).find((action) => action.action === "RETURN") ?? null;
}

/** 返回按时间倒序排列的审核记录副本，兼容当前 TypeScript 运行目标。 */
function reverseReviewActions(actions: TResearchChainStageReviewAction[]): TResearchChainStageReviewAction[] {
  const copied = [...actions];
  copied.reverse();
  return copied;
}

/** 提取意见的第一行，避免折叠摘要被长文本撑开。 */
function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0].trim();
}

/** 从审核快照中提取材料标题。 */
function snapshotTitles(action: TResearchChainStageReviewAction | null): string[] {
  if (!action) return [];
  return action.material_snapshot.flatMap((item) => {
    const titles = (item as { titles?: unknown }).titles;
    return Array.isArray(titles) ? titles.filter((title): title is string => typeof title === "string") : [];
  });
}

/** 对比历史退回时的材料标题与当前材料标题。 */
function materialChange(stage: TResearchChainStageApproval, action: TResearchChainStageReviewAction | null) {
  const previous = new Set(snapshotTitles(action));
  const current = new Set(stage.materials.flatMap((material) => material.items.map((item) => item.title)));
  return {
    added: [...current].filter((title) => !previous.has(title)),
    removed: [...previous].filter((title) => !current.has(title)),
  };
}

/**
 * 单个科研链阶段的材料、提交审核与审批历史面板。
 */
export function ResearchChainStageApprovalPanel({
  workspaceSlug,
  chainId,
  stage,
  nodes,
  preferredNodeId,
  applicantName,
  defaultExpanded = false,
  knowledge,
  onCreateNode,
  onChanged,
  onDecision,
}: Props) {
  const { t, currentLocale } = useTranslation();
  const effectiveUploadLimits = knowledge.uploadLimits ?? DEFAULT_RESEARCH_CHAIN_UPLOAD_LIMITS;
  const candidateNodes = useMemo(
    () => nodes.filter((node) => nodeMatchesStage(node, nodes, stage.stage_code)),
    [nodes, stage.stage_code]
  );
  const submittableNodes = useMemo(
    () => candidateNodes.filter((node) => SUBMITTABLE_NODE_STATUSES.has(node.status)),
    [candidateNodes]
  );
  const firstMissingMaterial = stage.materials.find((material) => !material.complete) ?? stage.materials[0];
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [requirementCode, setRequirementCode] = useState(firstMissingMaterial?.code ?? "");
  const [selectedUploadId, setSelectedUploadId] = useState("");
  const [nodeId, setNodeId] = useState(stage.submitted_node ?? preferredNodeId ?? submittableNodes[0]?.id ?? "");
  const [requiresPi, setRequiresPi] = useState(stage.requires_pi);
  const [escalationReason, setEscalationReason] = useState(stage.escalation_reason);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requirementSelectRef = useRef<HTMLSelectElement>(null);
  const missingMaterials = stage.materials.filter((material) => !material.complete);
  const selectedRequirement = stage.materials.find((material) => material.code === requirementCode);
  const linkableUploads = useMemo(
    () => knowledge.uploads.filter((upload) => LINKABLE_UPLOAD_STATUSES.has(upload.status)),
    [knowledge.uploads]
  );
  const linkedUploadIds = useMemo(
    () => new Set((selectedRequirement?.items ?? []).map((item) => item.upload).filter(Boolean) as string[]),
    [selectedRequirement]
  );
  const availableUploads = useMemo(
    () => linkableUploads.filter((upload) => !linkedUploadIds.has(upload.id)),
    [linkableUploads, linkedUploadIds]
  );
  const effectiveUploadId = availableUploads.some((upload) => upload.id === selectedUploadId)
    ? selectedUploadId
    : (availableUploads[0]?.id ?? "");
  const selectedNodeIdIsValid = submittableNodes.some((node) => node.id === nodeId);
  const effectiveNodeId = selectedNodeIdIsValid ? nodeId : (submittableNodes[0]?.id ?? "");
  const precheck = stage.latest_precheck;
  const precheckCurrent = precheck?.is_current ?? false;
  const stageThreeRequiresCurrentPrecheck = stage.stage_code === "TOPIC_EVALUATION";
  const materialReady =
    missingMaterials.length === 0 &&
    Boolean(effectiveNodeId) &&
    (!stageThreeRequiresCurrentPrecheck || (Boolean(precheck) && precheckCurrent));
  const latestReturned = latestReturn(stage);
  const change = materialChange(stage, latestReturned);
  const contentId = `${stage.id}-stage-approval-content`;
  const completedMaterials = stage.materials.length - missingMaterials.length;

  /** 将后端错误转换为具体材料或服务端原因。 */
  const describeActionError = (actionError: unknown): string => {
    const missing = (actionError as { missing?: unknown } | null | undefined)?.missing;
    if (Array.isArray(missing) && missing.length > 0) {
      const titles = missing.map(
        (code) => stage.materials.find((material) => material.code === code)?.title ?? String(code)
      );
      return t("research.chains.stage_approval.missing_materials", { materials: titles.join("、") });
    }
    return getResearchErrorDetail(actionError) ?? t("research.chains.stage_approval.action_failed");
  };

  /** 将一份已上传课题资料关联到当前材料要求。 */
  const addMaterial = async (uploadId: string) => {
    if (!requirementCode || !uploadId || busy) return;
    setBusy(true);
    setError("");
    const nextMissing = stage.materials.find(
      (material) => material.code !== requirementCode && !material.complete
    )?.code;
    try {
      await chainService.createChainStageMaterial(workspaceSlug, chainId, stage.stage_code, {
        requirement_code: requirementCode,
        upload_id: uploadId,
      });
      setSelectedUploadId("");
      if (nextMissing) setRequirementCode(nextMissing);
      await onChanged();
    } catch (actionError) {
      setError(describeActionError(actionError));
    } finally {
      setBusy(false);
    }
  };

  /** 切换到某个缺失材料的关联表单。 */
  const supplementMaterial = (code: string) => {
    setRequirementCode(code);
    requirementSelectRef.current?.focus();
  };

  /** 上传一份资料并立即关联到当前材料要求。 */
  const uploadAndLink = async (files: File[]) => {
    if (!requirementCode || busy || !knowledge.canUpload || files.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const created = await knowledge.uploadFiles(files.slice(0, 1));
      const upload = created.find((item) => LINKABLE_UPLOAD_STATUSES.has(item.status));
      if (!upload) return;
      await chainService.createChainStageMaterial(workspaceSlug, chainId, stage.stage_code, {
        requirement_code: requirementCode,
        upload_id: upload.id,
      });
      setSelectedUploadId("");
      const nextMissing = stage.materials.find(
        (material) => material.code !== requirementCode && !material.complete
      )?.code;
      if (nextMissing) setRequirementCode(nextMissing);
      await onChanged();
    } catch (actionError) {
      setError(describeActionError(actionError));
    } finally {
      setBusy(false);
    }
  };

  /** 删除一个尚未提交审核的材料条目。 */
  const removeMaterial = async (materialId: string) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await chainService.deleteChainStageMaterial(workspaceSlug, chainId, stage.stage_code, materialId);
      await onChanged();
    } catch (actionError) {
      setError(describeActionError(actionError));
    } finally {
      setBusy(false);
    }
  };

  /** 生成阶段 03 的规则材料预检。 */
  const runPrecheck = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await chainService.runChainStagePrecheck(workspaceSlug, chainId, stage.stage_code);
      await onChanged();
    } catch (actionError) {
      setError(describeActionError(actionError));
    } finally {
      setBusy(false);
    }
  };

  /** 提交当前阶段进入导师审核。 */
  const submitStage = async () => {
    if (!materialReady || busy) return;
    setBusy(true);
    setError("");
    try {
      await chainService.submitChainStage(workspaceSlug, chainId, stage.stage_code, {
        node_id: effectiveNodeId,
        requires_pi: requiresPi || undefined,
        escalation_reason: escalationReason.trim() || undefined,
      });
      setComment("");
      await onChanged();
    } catch (actionError) {
      setError(describeActionError(actionError));
    } finally {
      setBusy(false);
    }
  };

  /** 执行导师或主 PI 审批。 */
  const reviewStage = async (intent: TReviewIntent, escalateToPi?: boolean) => {
    if (busy || (intent === "RETURN" && !comment.trim())) return;
    setBusy(true);
    setError("");
    try {
      const updatedStage = await chainService.reviewChainStage(workspaceSlug, chainId, stage.stage_code, {
        action: intent,
        comment: comment.trim() || undefined,
        ...(escalateToPi === undefined ? {} : { escalate_to_pi: escalateToPi }),
      });
      setComment("");
      await onDecision?.(updatedStage);
      await onChanged();
    } catch (actionError) {
      setError(describeActionError(actionError));
    } finally {
      setBusy(false);
    }
  };

  const approveEscalates =
    stage.status === "AWAITING_ADVISOR" &&
    (stage.pi_policy === "ALWAYS_PI" || (stage.pi_policy === "CONDITIONAL_PI" && stage.requires_pi));
  const approveLabel = approveEscalates
    ? t("research.chains.stage_approval.approve_to_pi")
    : stage.status === "AWAITING_ADVISOR" && stage.pi_policy === "CONDITIONAL_PI"
      ? t("research.chains.stage_approval.approve_only_advisor")
      : t("research.chains.stage_approval.approve");

  return (
    <section className="border-t border-subtle" aria-label={t("research.chains.stage_approval.title")}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-2"
      >
        <span className="min-w-0">
          <span className="block text-13 font-medium text-primary">{t("research.chains.stage_approval.title")}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-11 text-secondary">
            <span>{t(`research.chains.workflow.stage_status.${stage.status.toLowerCase()}`)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {t("research.chains.stage_approval.summary_materials", {
                completed: completedMaterials,
                total: stage.materials.length,
              })}
            </span>
            <span aria-hidden="true">·</span>
            <span>{t(actionKey(stage, submittableNodes.length > 0))}</span>
            {stage.status === "NEEDS_REVISION" && latestReturned?.comment && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate">{firstLine(latestReturned.comment)}</span>
              </>
            )}
          </span>
        </span>
        <span className="shrink-0 text-12 text-tertiary" aria-hidden="true">
          {expanded ? "−" : "+"}
        </span>
      </button>

      {expanded && (
        <div id={contentId} className="border-t border-subtle">
          {error && (
            <p className="px-4 py-2 text-12 text-danger-primary" role="alert">
              {error}
            </p>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.25fr)_minmax(320px,1fr)]">
            <section className="border-b border-subtle py-3 pr-4 pl-4 lg:border-r lg:border-b">
              <h5 className="text-12 font-medium text-secondary">{t("research.chains.stage_approval.materials")}</h5>
              <ul className="mt-1 divide-y divide-subtle" role="list">
                {stage.materials.map((material) => (
                  <li key={material.id} className="flex items-start justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-13 text-primary">{material.title}</p>
                      <p className="mt-0.5 text-11 text-tertiary">
                        {t("research.chains.stage_approval.material_count", {
                          submitted: material.submitted_count,
                          required: material.minimum_count,
                        })}
                        {" · "}
                        {material.complete
                          ? t("research.chains.stage_approval.material_satisfied")
                          : t("research.chains.stage_approval.material_missing")}
                      </p>
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
                            ) : (
                              <span key={item.id} className="truncate text-11 text-tertiary">
                                {item.upload_detail
                                  ? `${item.upload_detail.file_name} · ${t(researchChainUploadStatusKey(item.upload_detail.status))}`
                                  : `${item.title} · ${t("research.chains.stage_approval.unlinked_file")}`}
                              </span>
                            )
                          )}
                        </span>
                      )}
                    </div>
                    <span className="flex shrink-0 items-center gap-2">
                      {!material.complete && can(stage, "edit_materials") && (
                        <button
                          type="button"
                          className="text-11 text-secondary hover:text-primary"
                          aria-controls={`${stage.id}-stage-material-link-form`}
                          onClick={() => supplementMaterial(material.code)}
                        >
                          {t("research.chains.stage_approval.supplement")}
                        </button>
                      )}
                      {can(stage, "remove_material") && material.items.length > 0 && (
                        <button
                          type="button"
                          className="text-11 text-tertiary hover:text-primary"
                          disabled={busy}
                          onClick={() => void removeMaterial(material.items[material.items.length - 1].id)}
                        >
                          {t("research.chains.stage_approval.remove_last")}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>

              {can(stage, "edit_materials") && (
                <div id={`${stage.id}-stage-material-link-form`} className="mt-3 space-y-2 border-t border-subtle pt-3">
                  {knowledge.state !== "ready" && knowledge.state !== "degraded" && (
                    <p className="text-11 text-secondary">{t("research.chains.stage_approval.upload_unavailable")}</p>
                  )}
                  {knowledge.state !== "loading" && knowledge.state !== "idle" && linkableUploads.length === 0 && (
                    <p className="text-11 text-secondary">{t("research.chains.stage_approval.upload_empty")}</p>
                  )}
                  {knowledge.actionError && (
                    <p className="text-11 text-danger-primary" role="alert">
                      {knowledge.actionError}
                    </p>
                  )}
                  <div className="grid gap-2 sm:grid-cols-[minmax(150px,0.65fr)_minmax(180px,1fr)_auto]">
                    <select
                      ref={requirementSelectRef}
                      value={requirementCode}
                      onChange={(event) => setRequirementCode(event.target.value)}
                      aria-label={t("research.chains.stage_approval.requirement")}
                      className="focus:outline-accent-primary rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary focus:outline focus:outline-1 focus:outline-offset-1"
                    >
                      {stage.materials.map((material) => (
                        <option key={material.id} value={material.code}>
                          {material.title}
                        </option>
                      ))}
                    </select>
                    <select
                      value={effectiveUploadId}
                      onChange={(event) => setSelectedUploadId(event.target.value)}
                      aria-label={t("research.chains.stage_approval.select_upload")}
                      disabled={availableUploads.length === 0}
                      className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
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
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy || !effectiveUploadId}
                      onClick={() => void addMaterial(effectiveUploadId)}
                    >
                      {t("research.chains.stage_approval.link_material")}
                    </Button>
                  </div>
                  <AttachmentUploadZone
                    onFiles={(files) => void uploadAndLink(files)}
                    accept={{
                      "application/pdf": [".pdf"],
                      "text/markdown": [".md", ".markdown"],
                      "text/plain": [".txt"],
                      "application/msword": [".doc"],
                      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
                    }}
                    maxSize={
                      knowledge.maxUploadSizeBytes ?? Math.max(...Object.values(effectiveUploadLimits)) * 1024 * 1024
                    }
                    disabled={!knowledge.canUpload || busy}
                    uploading={knowledge.uploading || busy}
                    variant="inline"
                    title={t("research.chains.stage_approval.material_upload")}
                    uploadingTitle={t("research.knowledge.uploading")}
                    hint={t("research.knowledge.upload_hint", researchChainUploadHintParams(effectiveUploadLimits))}
                  />
                </div>
              )}
            </section>

            <section className="py-3 pr-4 pl-4">
              <h5 className="text-12 font-medium text-secondary">
                {t("research.chains.stage_approval.submit_review")}
              </h5>
              <p className="mt-1 text-12 text-primary">
                {stage.pi_policy === "ADVISOR_ONLY"
                  ? t("research.chains.stage_approval.route_advisor")
                  : stage.pi_policy === "ALWAYS_PI"
                    ? t("research.chains.stage_approval.route_advisor_pi")
                    : t("research.chains.stage_approval.route_conditional")}
              </p>
              <p className="mt-1 text-11 text-secondary">
                {t("research.chains.stage_approval.current_handler")}:{" "}
                {stage.status === "AWAITING_PI"
                  ? (stage.principal_investigator.user?.display_name ?? stage.principal_investigator.error ?? "-")
                  : (stage.advisor.user?.display_name ?? stage.advisor.error ?? "-")}
              </p>

              {can(stage, "review") && (
                <div className="mt-3 space-y-1 border-t border-subtle pt-3 text-12">
                  {applicantName && (
                    <p className="text-primary">
                      {t("research.chains.stage_approval.applicant")}: {applicantName}
                    </p>
                  )}
                  <p className="text-secondary">
                    {t(stageLabelKey(stage.stage_code))} · {t("research.chains.stage_approval.current_step")}:{" "}
                    {stage.current_review_step === "PI"
                      ? t("research.chains.stage_approval.role_pi")
                      : t("research.chains.stage_approval.role_advisor")}
                  </p>
                  {latestReturned?.comment && (
                    <p className="text-secondary">
                      {t("research.chains.stage_approval.latest_return")}: {firstLine(latestReturned.comment)}
                    </p>
                  )}
                  {(change.added.length > 0 || change.removed.length > 0) && (
                    <p className="text-tertiary">
                      {change.added.length > 0 && `+${change.added.join("、")}`}
                      {change.added.length > 0 && change.removed.length > 0 ? " / " : ""}
                      {change.removed.length > 0 && `-${change.removed.join("、")}`}
                    </p>
                  )}
                </div>
              )}

              {can(stage, "submit") && (
                <div className="mt-3 space-y-2 border-t border-subtle pt-3">
                  <p className="text-11 font-medium text-secondary">
                    {t("research.chains.stage_approval.submit_check")}
                  </p>
                  {submittableNodes.length === 0 ? (
                    <>
                      <p className="text-11 text-secondary">{t("research.chains.stage_approval.no_node")}</p>
                      {onCreateNode && (
                        <Button type="button" variant="primary" size="sm" disabled={busy} onClick={onCreateNode}>
                          {t("research.chains.stage_approval.create_stage_node")}
                        </Button>
                      )}
                    </>
                  ) : (
                    <>
                      <select
                        value={effectiveNodeId}
                        onChange={(event) => setNodeId(event.target.value)}
                        aria-label={t("research.chains.stage_approval.node")}
                        className="w-full rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
                      >
                        {submittableNodes.map((node) => (
                          <option key={node.id} value={node.id}>
                            {node.title}
                          </option>
                        ))}
                      </select>
                      {stage.pi_policy === "CONDITIONAL_PI" && (
                        <label className="flex items-center gap-2 text-11 text-secondary">
                          <input
                            type="checkbox"
                            checked={requiresPi}
                            onChange={(event) => setRequiresPi(event.target.checked)}
                          />
                          {t("research.chains.stage_approval.declare_pi")}
                        </label>
                      )}
                      {stage.pi_policy === "CONDITIONAL_PI" && requiresPi && (
                        <input
                          value={escalationReason}
                          onChange={(event) => setEscalationReason(event.target.value)}
                          placeholder={t("research.chains.stage_approval.escalation_reason")}
                          className="w-full rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
                        />
                      )}
                      <p className="text-11 text-tertiary">{t("research.chains.stage_approval.submit_consequence")}</p>
                    </>
                  )}

                  {stageThreeRequiresCurrentPrecheck && (
                    <div className="space-y-1.5 border-t border-subtle pt-2">
                      <p className="text-11 font-medium text-primary">{t("research.chains.stage_approval.precheck")}</p>
                      {precheck ? (
                        <>
                          <p className="text-11 text-secondary">
                            {t("research.chains.stage_approval.precheck_generated_at")}:{" "}
                            {formatResearchDateTime(precheck.created_at, currentLocale)}
                            {" · "}
                            {t("research.chains.stage_approval.material_version")}: {precheck.material_version}
                            {" · "}
                            {precheckCurrent
                              ? t("research.chains.stage_approval.precheck_current")
                              : t("research.chains.stage_approval.precheck_expired")}
                          </p>
                          <ul className="text-11 text-secondary" role="list">
                            {precheck.checks.map((check) => {
                              const code = typeof check.code === "string" ? check.code : JSON.stringify(check);
                              const requirement = stage.materials.find((material) => material.code === code);
                              return (
                                <li key={code}>
                                  {requirement?.title ?? code}:{" "}
                                  {check.passed
                                    ? t("research.chains.stage_approval.material_satisfied")
                                    : t("research.chains.stage_approval.material_missing")}
                                </li>
                              );
                            })}
                          </ul>
                        </>
                      ) : (
                        <p className="text-11 text-secondary">
                          {t("research.chains.stage_approval.precheck_required")}
                        </p>
                      )}
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={busy}
                        onClick={() => void runPrecheck()}
                      >
                        {precheckCurrent
                          ? t("research.chains.stage_approval.run_precheck")
                          : t("research.chains.stage_approval.rerun_precheck")}
                      </Button>
                    </div>
                  )}

                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    disabled={busy || !materialReady || (requiresPi && !escalationReason.trim())}
                    onClick={() => void submitStage()}
                  >
                    {t("research.chains.stage_approval.submit")}
                  </Button>
                  {missingMaterials.length > 0 && (
                    <p className="text-11 text-tertiary">
                      {t("research.chains.stage_approval.missing_summary", { count: missingMaterials.length })}
                    </p>
                  )}
                </div>
              )}

              {can(stage, "review") && (
                <div className="mt-3 space-y-2 border-t border-subtle pt-3">
                  <textarea
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    placeholder={t("research.chains.stage_approval.review_comment")}
                    rows={3}
                    className="w-full rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void reviewStage("APPROVE", approveEscalates || undefined)}
                    >
                      {approveLabel}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy || !comment.trim()}
                      onClick={() => void reviewStage("RETURN")}
                    >
                      {t("research.chains.stage_approval.return")}
                    </Button>
                  </div>
                </div>
              )}
            </section>
          </div>

          {stage.review_actions.length > 0 && (
            <section className="border-t border-subtle px-4 py-3">
              <button
                type="button"
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen((value) => !value)}
                className="text-12 font-medium text-secondary hover:text-primary"
              >
                {t("research.chains.stage_approval.history_count", { count: stage.review_actions.length })}
              </button>
              {historyOpen && (
                <ol className="mt-1 divide-y divide-subtle text-11" role="list">
                  {reverseReviewActions(stage.review_actions).map((action) => (
                    <li key={action.id} className="py-2 first:pt-0 last:pb-0">
                      <p className="text-primary">
                        {action.reviewer_detail?.display_name ?? "-"} ·{" "}
                        {t(`research.chains.stage_approval.role_${action.reviewer_role.toLowerCase()}`)} ·{" "}
                        {t(`research.chains.stage_approval.action_${action.action.toLowerCase()}`)}
                      </p>
                      {action.comment && <p className="mt-1 text-secondary">{action.comment}</p>}
                      <p className="mt-0.5 text-tertiary">{formatResearchDateTime(action.created_at, currentLocale)}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          )}
        </div>
      )}
    </section>
  );
}
