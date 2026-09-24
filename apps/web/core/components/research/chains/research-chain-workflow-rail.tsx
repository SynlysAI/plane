/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { AlertTriangle, Check, ChevronRight, CircleDot } from "lucide-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import type { TResearchChainNode } from "@plane/types";
// components
import {
  buildResearchWorkflow,
  type TResearchWorkflowStageId,
  type TResearchWorkflowStage,
} from "@/components/research/chains/research-chain-workflow";

type Props = {
  nodes: TResearchChainNode[];
  currentNodeId: string | null;
  selectedStageId: TResearchWorkflowStageId | null;
  onSelectStage: (stage: TResearchWorkflowStage) => void;
};

type TStepKind = "completed" | "current" | "attention" | "archived" | "upcoming";

/** Derive the visual step kind while keeping text status separate from color. */
function stepKind(stage: TResearchWorkflowStage): TStepKind {
  if (stage.isCurrent) return "current";
  if (stage.status === "COMPLETED") return "completed";
  if (stage.status === "ARCHIVED") return "archived";
  if (stage.status === "WAITING_HUMAN" || stage.status === "NEEDS_REVISION" || stage.status === "FAILED")
    return "attention";
  return "upcoming";
}

const STEP_DOT_CLASSES: Record<TStepKind, string> = {
  completed: "border-success-subtle bg-success-subtle-1 text-success-primary",
  current: "border-accent-strong bg-accent-primary text-on-color",
  attention: "border-warning-subtle bg-warning-subtle text-warning-primary",
  archived: "border-subtle bg-surface-2 text-tertiary",
  upcoming: "border-subtle bg-surface-2 text-tertiary",
};

const STEP_TITLE_CLASSES: Record<TStepKind, string> = {
  completed: "text-secondary",
  current: "font-medium text-primary",
  attention: "font-medium text-primary",
  archived: "text-tertiary",
  upcoming: "text-tertiary",
};

const STEP_SURFACE_CLASSES: Record<TStepKind, string> = {
  completed: "border-transparent bg-surface-1 hover:bg-surface-2",
  current: "border-accent-strong bg-surface-1",
  attention: "border-transparent bg-surface-1 hover:bg-surface-2",
  archived: "border-transparent bg-surface-1/60 opacity-70 hover:bg-surface-2",
  upcoming: "border-transparent bg-surface-1/60 hover:bg-surface-2",
};

/**
 * Fixed thirteen-stage research workflow map. It communicates the complete flow,
 * the real current position and a temporary viewing position without changing node state.
 */
export function ResearchChainWorkflowRail({ nodes, currentNodeId, selectedStageId, onSelectStage }: Props) {
  const { t } = useTranslation();
  const workflow = buildResearchWorkflow(nodes, currentNodeId);

  return (
    <section
      className="shrink-0 overflow-x-auto border-b border-subtle bg-canvas px-5 py-3"
      aria-label={t("research.chains.workflow_title")}
    >
      <div className="flex min-w-max items-stretch gap-1" role="list">
        {workflow.stages.map((stage, index) => {
          const kind = stepKind(stage);
          const selected = selectedStageId === stage.id;
          const statusLabel =
            stage.status === "NOT_STARTED"
              ? t("research.chains.workflow.not_started")
              : t(`research.chains.node_status.${stage.status.toLowerCase()}`);
          const summary = [statusLabel, stage.shared ? t("research.chains.workflow.shared") : ""]
            .filter(Boolean)
            .join(" · ");
          const stageTitle =
            stage.status === "NOT_STARTED"
              ? `${t(stage.labelKey)} · ${summary} · ${t("research.chains.workflow.not_started_hint")}`
              : `${t(stage.labelKey)} · ${summary}`;

          return (
            <div key={stage.id} className="flex items-stretch" role="listitem">
              {index > 0 && (
                <span className="flex w-4 items-center text-tertiary" aria-hidden="true">
                  <ChevronRight className="size-3.5" />
                </span>
              )}
              <button
                type="button"
                onClick={() => onSelectStage(stage)}
                aria-current={stage.isCurrent ? "step" : undefined}
                aria-pressed={selected || undefined}
                title={stageTitle}
                className={`flex max-w-36 min-w-28 flex-col gap-1.5 rounded-md border px-2.5 py-2 text-left transition-colors ${STEP_SURFACE_CLASSES[kind]} ${
                  selected ? "ring-border-strong border-strong ring-1" : ""
                }`}
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={`grid size-4 shrink-0 place-items-center rounded-full border ${STEP_DOT_CLASSES[kind]}`}
                    aria-hidden="true"
                  >
                    {kind === "completed" && <Check className="size-2.5" strokeWidth={3} />}
                    {kind === "current" && <CircleDot className="size-2.5" strokeWidth={3} />}
                    {kind === "attention" && <AlertTriangle className="size-2.5" strokeWidth={3} />}
                  </span>
                  <span className={`truncate text-12 ${STEP_TITLE_CLASSES[kind]}`}>{t(stage.labelKey)}</span>
                </span>
                <span className="truncate text-11 text-secondary">{statusLabel}</span>
                {stage.shared && (
                  <span className="truncate text-10 text-tertiary">{t("research.chains.workflow.shared")}</span>
                )}
                {stage.associatedNodeIds.length > 0 && (
                  <span className="truncate text-10 text-tertiary">{t("research.chains.workflow.preparation")}</span>
                )}
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
