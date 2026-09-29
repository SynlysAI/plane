/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Link from "next/link";
// plane imports
import { useTranslation } from "@plane/i18n";
import { Button, getButtonStyling } from "@plane/propel/button";
import { EmptyStateCompact, EmptyStateDetailed } from "@plane/propel/empty-state";
import { Spinner } from "@plane/ui";

/** 通用空态文案与行动配置，供未内置 resource 枚举的科研列表复用。 */
export type TResearchListStateConfig = {
  titleKey: string;
  descriptionKey: string;
  createLabelKey?: string;
};

type Props = {
  kind: "loading" | "error" | "empty" | "no-results" | "forbidden" | "disabled";
  resource: "projects" | "reports";
  /** 未列入 resource 枚举的列表使用通用配置覆盖默认文案。 */
  config?: TResearchListStateConfig;
  /** 列表内嵌空态用 compact（默认），整页空态用 detailed。 */
  variant?: "compact" | "detailed";
  onRetry?: () => void;
  onClearFilters?: () => void;
  createHref?: string;
};

/** Consistent loading, error, empty, permission and disabled states for research data lists. */
export function ResearchListState({
  kind,
  resource,
  config,
  variant = "compact",
  onRetry,
  onClearFilters,
  createHref,
}: Props) {
  const { t } = useTranslation();
  const titleKey = config?.titleKey ?? `research.list_state.${resource}.${kind}.title`;
  const descriptionKey = config?.descriptionKey ?? `research.list_state.${resource}.${kind}.description`;
  const createLabel = t(config?.createLabelKey ?? `research.list_state.${resource}.create`);
  const stateRole = kind === "error" || kind === "forbidden" ? "alert" : "status";

  if (kind === "loading") {
    return (
      <div
        className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-dashed border-subtle p-6 text-center"
        role={stateRole}
        aria-busy="true"
      >
        <Spinner />
        <h3 className="mt-2 text-13 font-medium text-primary">{t(titleKey)}</h3>
      </div>
    );
  }

  if (kind === "error" || kind === "forbidden") {
    return (
      <div
        className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-dashed border-subtle p-6 text-center"
        role={stateRole}
      >
        <h3 className="text-13 font-medium text-primary">{t(titleKey)}</h3>
        <p className="mt-1 max-w-md text-12 text-tertiary">{t(descriptionKey)}</p>
        {kind === "error" && onRetry && (
          <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
            {t("research.status.retry")}
          </Button>
        )}
      </div>
    );
  }

  if (kind === "no-results") {
    return (
      <div
        className="flex min-h-40 flex-col items-center justify-center rounded-lg border border-dashed border-subtle p-6 text-center"
        role={stateRole}
      >
        <h3 className="text-13 font-medium text-primary">{t(titleKey)}</h3>
        <p className="mt-1 max-w-md text-12 text-tertiary">{t(descriptionKey)}</p>
        {onClearFilters && (
          <Button variant="secondary" size="sm" className="mt-3" onClick={onClearFilters}>
            {t("research.list_state.clear_filters")}
          </Button>
        )}
      </div>
    );
  }

  const createAction =
    createHref && kind === "empty" ? (
      <Link href={createHref} className={getButtonStyling("primary", "base")}>
        {createLabel}
      </Link>
    ) : undefined;

  return variant === "detailed" ? (
    <div role={stateRole} className="min-h-64">
      <EmptyStateDetailed
        title={t(titleKey)}
        description={t(descriptionKey)}
        align="center"
        customButton={createAction}
      />
    </div>
  ) : (
    <div role={stateRole} className="min-h-40">
      <EmptyStateCompact
        title={t(titleKey)}
        description={t(descriptionKey)}
        align="center"
        customButton={createAction}
      />
    </div>
  );
}
