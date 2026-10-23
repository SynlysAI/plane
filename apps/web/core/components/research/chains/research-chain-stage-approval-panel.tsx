/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo, useState } from "react";

import { useTranslation } from "@plane/i18n";
import type { TResearchChainNode, TResearchChainStageApproval } from "@plane/types";
import { Button } from "@plane/propel/button";

import { ResearchChainService } from "@/services/research/chain.service";
import { formatResearchDateTime } from "@/components/research/common/research-format";

type Props = {
  workspaceSlug: string;
  chainId: string;
  stage: TResearchChainStageApproval;
  nodes: TResearchChainNode[];
  preferredNodeId: string | null;
  onChanged: () => Promise<void> | void;
};

type TReviewIntent = "APPROVE" | "RETURN";

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

/**
 * 单个科研链阶段的材料、审批路径与审批历史面板。
 */
export function ResearchChainStageApprovalPanel({
  workspaceSlug,
  chainId,
  stage,
  nodes,
  preferredNodeId,
  onChanged,
}: Props) {
  const { t, currentLocale } = useTranslation();
  const candidateNodes = useMemo(
    () => nodes.filter((node) => nodeMatchesStage(node, nodes, stage.stage_code)),
    [nodes, stage.stage_code]
  );
  const [requirementCode, setRequirementCode] = useState(stage.materials[0]?.code ?? "");
  const [materialTitle, setMaterialTitle] = useState("");
  const [materialReference, setMaterialReference] = useState("");
  const [nodeId, setNodeId] = useState(stage.submitted_node ?? preferredNodeId ?? candidateNodes[0]?.id ?? "");
  const [requiresPi, setRequiresPi] = useState(false);
  const [escalationReason, setEscalationReason] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const missingCount = stage.materials.filter((material) => !material.complete).length;
  const selectedRequirement = stage.materials.find((material) => material.code === requirementCode);
  const materialReady = missingCount === 0 && Boolean(nodeId);

  /** 提交一个硬性材料条目。 */
  const addMaterial = async () => {
    if (!requirementCode || !materialTitle.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await chainService.createChainStageMaterial(workspaceSlug, chainId, stage.stage_code, {
        requirement_code: requirementCode,
        title: materialTitle.trim(),
        external_reference: materialReference.trim() || undefined,
        source_node_id: nodeId || undefined,
      });
      setMaterialTitle("");
      setMaterialReference("");
      await onChanged();
    } catch {
      setError(t("research.chains.stage_approval.action_failed"));
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
    } catch {
      setError(t("research.chains.stage_approval.action_failed"));
    } finally {
      setBusy(false);
    }
  };

  /** 生成阶段 03 的 AI 预检意见。 */
  const runPrecheck = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await chainService.runChainStagePrecheck(workspaceSlug, chainId, stage.stage_code);
      await onChanged();
    } catch {
      setError(t("research.chains.stage_approval.action_failed"));
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
        node_id: nodeId,
        requires_pi: requiresPi || undefined,
        escalation_reason: escalationReason.trim() || undefined,
      });
      setComment("");
      await onChanged();
    } catch {
      setError(t("research.chains.stage_approval.action_failed"));
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
      await chainService.reviewChainStage(workspaceSlug, chainId, stage.stage_code, {
        action: intent,
        comment: comment.trim() || undefined,
        ...(escalateToPi === undefined ? {} : { escalate_to_pi: escalateToPi }),
      });
      setComment("");
      await onChanged();
    } catch {
      setError(t("research.chains.stage_approval.action_failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="border-t border-subtle" aria-label={t("research.chains.stage_approval.title")}>
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <h4 className="text-14 font-semibold text-primary">{t("research.chains.stage_approval.title")}</h4>
          <p className="mt-0.5 text-11 text-tertiary">
            {t(`research.chains.workflow.stage_status.${stage.status.toLowerCase()}`)}
            {stage.attempt_count > 0
              ? ` · ${t("research.chains.stage_approval.attempt", { count: stage.attempt_count })}`
              : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-11 text-secondary">
          <span>
            {t("research.chains.stage_approval.advisor")}:{" "}
            {stage.advisor.user?.display_name ?? stage.advisor.error ?? "-"}
          </span>
          {stage.pi_policy !== "ADVISOR_ONLY" && (
            <span>
              {t("research.chains.stage_approval.pi")}:{" "}
              {stage.principal_investigator.user?.display_name ?? stage.principal_investigator.error ?? "-"}
            </span>
          )}
        </div>
      </header>

      {error && (
        <p className="border-t border-subtle px-4 py-2 text-12 text-danger-primary" role="alert">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-0 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,1fr)]">
        <div className="border-b border-subtle lg:border-r lg:border-b-0">
          <h5 className="px-4 pt-3 text-12 font-medium text-secondary">
            {t("research.chains.stage_approval.materials")}
          </h5>
          <ul className="divide-y divide-subtle" role="list">
            {stage.materials.map((material) => (
              <li key={material.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-13 text-primary">{material.title}</p>
                    <p className="mt-0.5 text-11 text-tertiary">
                      {t("research.chains.stage_approval.material_count", {
                        submitted: material.submitted_count,
                        required: material.minimum_count,
                      })}
                      {material.complete ? "" : ` · ${t("research.chains.stage_approval.material_missing")}`}
                    </p>
                  </div>
                  {can(stage, "remove_material") && material.items.length > 0 && (
                    <button
                      type="button"
                      className="shrink-0 text-11 text-secondary hover:text-primary"
                      onClick={() => void removeMaterial(material.items[material.items.length - 1].id)}
                    >
                      {t("research.chains.stage_approval.remove_last")}
                    </button>
                  )}
                </div>
                {material.items.length > 0 && (
                  <ul className="mt-2 space-y-1 text-11 text-secondary" role="list">
                    {material.items.map((item) => (
                      <li key={item.id} className="truncate">
                        {item.title}
                        {item.external_reference ? ` · ${item.external_reference}` : ""}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
          {can(stage, "edit_materials") && (
            <form
              className="grid gap-2 border-t border-subtle px-4 py-3 sm:grid-cols-[minmax(140px,0.6fr)_minmax(180px,1fr)_auto]"
              onSubmit={(event) => {
                event.preventDefault();
                void addMaterial();
              }}
            >
              <select
                value={requirementCode}
                onChange={(event) => setRequirementCode(event.target.value)}
                aria-label={t("research.chains.stage_approval.requirement")}
                className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
              >
                {stage.materials.map((material) => (
                  <option key={material.id} value={material.code}>
                    {material.title}
                  </option>
                ))}
              </select>
              <input
                value={materialTitle}
                onChange={(event) => setMaterialTitle(event.target.value)}
                placeholder={
                  selectedRequirement
                    ? t("research.chains.stage_approval.material_title", { requirement: selectedRequirement.title })
                    : t("research.chains.stage_approval.material_title_fallback")
                }
                className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
              />
              <input
                value={materialReference}
                onChange={(event) => setMaterialReference(event.target.value)}
                placeholder={t("research.chains.stage_approval.reference")}
                className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary sm:col-span-2"
              />
              <Button type="submit" variant="secondary" size="sm" disabled={busy || !materialTitle.trim()}>
                {t("research.chains.stage_approval.add_material")}
              </Button>
            </form>
          )}
        </div>

        <div className="px-4 py-3">
          <h5 className="text-12 font-medium text-secondary">{t("research.chains.stage_approval.route")}</h5>
          <p className="mt-2 text-12 text-primary">
            {stage.pi_policy === "ADVISOR_ONLY"
              ? t("research.chains.stage_approval.route_advisor")
              : stage.pi_policy === "ALWAYS_PI"
                ? t("research.chains.stage_approval.route_advisor_pi")
                : t("research.chains.stage_approval.route_conditional")}
          </p>
          {stage.latest_precheck && (
            <div className="mt-3 border-t border-subtle pt-3">
              <p className="text-12 font-medium text-primary">{t("research.chains.stage_approval.precheck")}</p>
              <p className="mt-1 text-11 text-secondary">{stage.latest_precheck.summary}</p>
            </div>
          )}

          {can(stage, "submit") && (
            <div className="mt-4 space-y-2 border-t border-subtle pt-3">
              <select
                value={nodeId}
                onChange={(event) => setNodeId(event.target.value)}
                aria-label={t("research.chains.stage_approval.node")}
                className="w-full rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
              >
                {candidateNodes.map((node) => (
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
              {stage.stage_code === "TOPIC_EVALUATION" && (
                <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => void runPrecheck()}>
                  {t("research.chains.stage_approval.run_precheck")}
                </Button>
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
              {missingCount > 0 && (
                <p className="text-11 text-tertiary">
                  {t("research.chains.stage_approval.missing_summary", { count: missingCount })}
                </p>
              )}
            </div>
          )}

          {can(stage, "review") && (
            <div className="mt-4 space-y-2 border-t border-subtle pt-3">
              <textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder={t("research.chains.stage_approval.review_comment")}
                rows={3}
                className="w-full rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
              />
              <div className="flex flex-wrap gap-2">
                {stage.status === "AWAITING_ADVISOR" && stage.pi_policy === "CONDITIONAL_PI" && stage.requires_pi ? (
                  <>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void reviewStage("APPROVE", true)}
                    >
                      {t("research.chains.stage_approval.approve_to_pi")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => void reviewStage("APPROVE", false)}
                    >
                      {t("research.chains.stage_approval.approve_only_advisor")}
                    </Button>
                  </>
                ) : (
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => void reviewStage("APPROVE")}>
                    {t("research.chains.stage_approval.approve")}
                  </Button>
                )}
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

          {stage.review_actions.length > 0 && (
            <ol className="mt-4 space-y-0 border-t border-subtle pt-3" role="list">
              {stage.review_actions.map((action) => (
                <li key={action.id} className="py-2 text-11 first:pt-0 last:pb-0">
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
        </div>
      </div>
    </section>
  );
}
