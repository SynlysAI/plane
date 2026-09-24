/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { STAGE_STATUS_LABELS, STAGE_TYPE_LABELS } from "@plane/constants";
import type { TStageInstance } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
// components
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";

type Props = {
  stages: TStageInstance[];
  selectedStageId?: string | null;
  onSelect?: (stage: TStageInstance) => void;
};

/** Four fixed stages with their current state (P1-STG-01, P1-UI-02). */
export const StageTimeline = observer(function StageTimeline({ stages, selectedStageId, onSelect }: Props) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {stages.map((stage, index) => {
        const isSelected = stage.id === selectedStageId;
        return (
          <button
            key={stage.id}
            type="button"
            onClick={() => onSelect?.(stage)}
            className={`flex min-w-45 flex-1 flex-col gap-1 rounded-md border px-3 py-2 text-left transition-colors ${
              isSelected ? "border-accent-strong bg-surface-2" : "border-subtle hover:bg-surface-2"
            }`}
          >
            <span className="flex items-center justify-between text-12 text-tertiary">
              <span>{`${index + 1}. ${t(STAGE_TYPE_LABELS[stage.stage])}`}</span>
              {stage.attempt_count > 0 && <span>{`#${stage.attempt_count}`}</span>}
            </span>
            <ResearchStatusBadge status={stage.status} size="sm">
              {t(STAGE_STATUS_LABELS[stage.status])}
            </ResearchStatusBadge>
            {stage.gate_result && (
              <span className="text-11 text-tertiary">
                {t(`research.stages.gate_result.${stage.gate_result.toLowerCase()}`)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
});
