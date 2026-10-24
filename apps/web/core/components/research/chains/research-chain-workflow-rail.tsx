/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// plane imports
import { useTranslation } from "@plane/i18n";
import type { TResearchChainNode, TResearchChainStageApproval } from "@plane/types";
// components
import {
  buildResearchWorkflow,
  type TResearchWorkflowStageId,
  type TResearchWorkflowStage,
} from "@/components/research/chains/research-chain-workflow";

type Props = {
  nodes: TResearchChainNode[];
  stageApprovals: TResearchChainStageApproval[];
  currentNodeId: string | null;
  selectedStageId: TResearchWorkflowStageId | null;
  onSelectStage: (stage: TResearchWorkflowStage) => void;
};

type TStepKind = "approved" | "completed" | "current" | "attention" | "archived" | "upcoming";

/** 从阶段状态推导文字层级，不使用颜色或卡片底色区分。 */
function stepKind(stage: TResearchWorkflowStage): TStepKind {
  if (stage.isCurrent) return "current";
  if (stage.status === "APPROVED") return "approved";
  if (stage.status === "COMPLETED") return "completed";
  if (stage.status === "ARCHIVED") return "archived";
  if (
    stage.status === "AWAITING_ADVISOR" ||
    stage.status === "AWAITING_PI" ||
    stage.status === "WAITING_HUMAN" ||
    stage.status === "NEEDS_REVISION" ||
    stage.status === "FAILED"
  )
    return "attention";
  return "upcoming";
}

const NAME_CLASSES: Record<TStepKind, string> = {
  approved: "text-secondary",
  completed: "text-secondary",
  current: "font-medium text-primary underline decoration-accent-primary underline-offset-4",
  attention: "font-medium text-primary",
  archived: "text-tertiary",
  upcoming: "text-tertiary",
};

const STATUS_CLASSES: Record<TStepKind, string> = {
  approved: "text-secondary",
  completed: "text-secondary",
  current: "text-secondary",
  attention: "font-medium text-primary",
  archived: "text-tertiary",
  upcoming: "text-tertiary",
};

/** 将阶段序号格式化为两位数字，换行后仍能读出顺序。

Args:
  index: 阶段在固定流程中的从零开始序号。

Returns:
  两位数字序号。
 */
function stageIndexLabel(index: number): string {
  return String(index + 1).padStart(2, "0");
}

/** 优先显示后端阶段审批状态，旧节点状态仅作兼容回退。 */
function statusLabelKey(status: TResearchWorkflowStage["status"]): string {
  if (["NOT_STARTED", "IN_PROGRESS", "AWAITING_ADVISOR", "AWAITING_PI", "NEEDS_REVISION", "APPROVED"].includes(status))
    return `research.chains.workflow.stage_status.${status.toLowerCase()}`;
  return `research.chains.node_status.${status.toLowerCase()}`;
}

/**
 * 十三阶段流程地图。换行展示序号、名称和可见状态，不使用横向滚动。
 */
export function ResearchChainWorkflowRail({
  nodes,
  stageApprovals,
  currentNodeId,
  selectedStageId,
  onSelectStage,
}: Props) {
  const { t } = useTranslation();
  const workflow = buildResearchWorkflow(nodes, currentNodeId, stageApprovals);

  return (
    <section
      className="shrink-0 border-b border-subtle bg-surface-2 px-5 py-3"
      aria-label={t("research.chains.workflow_title")}
    >
      <div className="flex flex-wrap items-stretch gap-y-2" role="list">
        {workflow.stages.map((stage, index) => {
          const kind = stepKind(stage);
          const selected = selectedStageId === stage.id;
          const viewing = selected && !stage.isCurrent;
          const statusLabel = t(statusLabelKey(stage.status));
          const preparationLabel = stage.associatedNodeIds.length > 0 ? t("research.chains.workflow.preparation") : "";
          const stageTitle =
            stage.status === "NOT_STARTED"
              ? `${t(stage.labelKey)} · ${statusLabel} · ${t("research.chains.workflow.not_started_hint")}`
              : `${t(stage.labelKey)} · ${statusLabel}`;

          return (
            <div key={stage.id} className="flex items-stretch" role="listitem">
              {index > 0 && (
                <span className="flex items-center px-1.5 text-11 text-tertiary" aria-hidden="true">
                  →
                </span>
              )}
              <button
                type="button"
                onClick={() => onSelectStage(stage)}
                aria-current={stage.isCurrent ? "step" : undefined}
                aria-pressed={selected || undefined}
                title={stageTitle}
                className={`flex min-w-0 flex-col gap-0.5 rounded-md px-2 py-1 text-left transition-colors duration-150 hover:bg-surface-2 ${
                  viewing ? "bg-surface-2" : ""
                } ${kind === "archived" ? "opacity-70" : ""}`}
              >
                <span className="flex items-baseline gap-1.5">
                  <span className="text-10 text-tertiary tabular-nums">{stageIndexLabel(index)}</span>
                  <span className={`text-12 ${viewing ? "font-medium text-primary" : NAME_CLASSES[kind]}`}>
                    {t(stage.labelKey)}
                  </span>
                </span>
                <span className={`text-11 ${STATUS_CLASSES[kind]}`}>{statusLabel}</span>
                {preparationLabel && <span className="text-10 text-tertiary">{preparationLabel}</span>}
              </button>
            </div>
          );
        })}
      </div>
      {workflow.unmappedNodes.length > 0 && (
        <p className="mt-2 text-11 text-tertiary">
          {t("research.chains.workflow.unmapped")}: {workflow.unmappedNodes.map((node) => node.title).join("、")}
        </p>
      )}
    </section>
  );
}
