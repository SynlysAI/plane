/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { STAGE_TYPES, STAGE_TYPE_LABELS, INTEGRATION_SYSTEMS, INTEGRATION_SYSTEM_LABELS } from "@plane/constants";
import type { TTimelineFilters } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { ListFilterField, ListFilterInput, ListFilterSelect } from "@plane/ui";

type Props = {
  filters: TTimelineFilters;
  onChange: (filters: TTimelineFilters) => void;
};

/** Filters: chain, stage, time range and source system (P1-CHAIN-06). */
export const ChainFilters = observer(function ChainFilters({ filters, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full flex-wrap items-end gap-3">
      {(["", "thinking", "development"] as const).map((value) => (
        <button
          key={value || "all"}
          type="button"
          onClick={() => onChange({ ...filters, chain: value || undefined })}
          className={`h-8 rounded-md px-2 text-13 transition-colors ${
            (filters.chain ?? "") === value ? "bg-surface-1 text-primary" : "text-tertiary hover:bg-surface-1"
          }`}
        >
          {t(value ? `research.timeline.chain.${value}` : "research.timeline.chain.all")}
        </button>
      ))}
      <ListFilterField label="阶段">
        <ListFilterSelect
          value={filters.stage ?? ""}
          onChange={(event) => onChange({ ...filters, stage: event.target.value || undefined })}
        >
          <option value="">{t("research.timeline.all_stages")}</option>
          {STAGE_TYPES.map((value) => (
            <option key={value} value={value}>
              {t(STAGE_TYPE_LABELS[value])}
            </option>
          ))}
        </ListFilterSelect>
      </ListFilterField>
      <ListFilterField label="来源" className="sm:w-40">
        <ListFilterSelect
          value={filters.source_system ?? ""}
          onChange={(event) => onChange({ ...filters, source_system: event.target.value || undefined })}
        >
          <option value="">{t("research.timeline.all_sources")}</option>
          {INTEGRATION_SYSTEMS.map((value) => (
            <option key={value} value={value}>
              {t(INTEGRATION_SYSTEM_LABELS[value])}
            </option>
          ))}
        </ListFilterSelect>
      </ListFilterField>
      <ListFilterField label={t("research.common.date_from")} className="sm:w-40">
        <ListFilterInput
          type="date"
          value={filters.date_from ?? ""}
          onChange={(event) => onChange({ ...filters, date_from: event.target.value || undefined })}
        />
      </ListFilterField>
      <ListFilterField label={t("research.common.date_to")} className="sm:w-40">
        <ListFilterInput
          type="date"
          value={filters.date_to ?? ""}
          onChange={(event) => onChange({ ...filters, date_to: event.target.value || undefined })}
        />
      </ListFilterField>
    </div>
  );
});
