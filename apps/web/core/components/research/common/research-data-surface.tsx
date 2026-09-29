/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { ReactNode } from "react";

type TResearchListSurfaceProps = {
  /** Page-level list content. */
  children: ReactNode;
};

type TResearchFilterToolbarProps = {
  /** Filters, primary creation controls and compact metadata. */
  children: ReactNode;
};

type TResearchFilterChipsProps = {
  /** Human-readable active filter values. */
  filters: string[];
  activeLabel: string;
  clearLabel: string;
  onClear: () => void;
};

type TResearchTableSurfaceProps = {
  /** Propel Table content; the wrapper owns horizontal scrolling and surface. */
  children: ReactNode;
};

type TResearchDetailHeaderProps = {
  title: ReactNode;
  metadata?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
};

type TResearchDetailSurfaceProps = {
  title?: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** History, trace and low-frequency evidence default to collapsed. */
  collapsible?: boolean;
  defaultOpen?: boolean;
  className?: string;
};

/** Stable canvas, spacing and vertical rhythm for research list pages. */
export function ResearchListSurface({ children }: TResearchListSurfaceProps) {
  return <div className="flex h-full flex-col gap-4 overflow-y-auto bg-canvas p-5">{children}</div>;
}

/** Muted filter surface; creation controls stay in the same semantic group. */
export function ResearchFilterToolbar({ children }: TResearchFilterToolbarProps) {
  return <div className="flex flex-wrap items-end gap-2 rounded-lg bg-surface-2 px-3 py-2.5">{children}</div>;
}

/** Compact active-filter chips with one stable clear action. */
export function ResearchFilterChips({ filters, activeLabel, clearLabel, onClear }: TResearchFilterChipsProps) {
  if (!filters.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-11 text-tertiary">
      <span>{activeLabel}</span>
      {filters.map((filter) => (
        <span key={filter} className="rounded bg-surface-1 px-2 py-0.5 text-secondary">
          {filter}
        </span>
      ))}
      <button type="button" className="text-accent-primary hover:underline" onClick={onClear}>
        {clearLabel}
      </button>
    </div>
  );
}

/** Primary table surface with bounded horizontal scrolling. */
export function ResearchTableSurface({ children }: TResearchTableSurfaceProps) {
  return <div className="overflow-x-auto rounded-lg bg-surface-1">{children}</div>;
}

/** Unique detail-page object header; metadata is kept below the title baseline. */
export function ResearchDetailHeader({ title, metadata, hint, actions }: TResearchDetailHeaderProps) {
  return (
    <section className="rounded-xl bg-surface-1 px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-18 font-semibold text-primary">{title}</h2>
          {metadata && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-12 text-secondary">{metadata}</div>
          )}
          {hint && <p className="mt-1.5 text-12 text-tertiary">{hint}</p>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
      </div>
    </section>
  );
}

/** Primary detail section; optionally renders low-frequency evidence as a disclosure. */
export function ResearchDetailSurface({
  title,
  hint,
  actions,
  children,
  collapsible = false,
  defaultOpen = false,
  className,
}: TResearchDetailSurfaceProps) {
  const surfaceClassName = "overflow-hidden rounded-xl bg-surface-1";

  if (collapsible) {
    return (
      <details className={[surfaceClassName, className].filter(Boolean).join(" ")} open={defaultOpen}>
        {(title || actions) && (
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-13 font-medium text-primary">
            {title}
            {actions}
          </summary>
        )}
        {hint && <p className="px-4 text-11 text-tertiary">{hint}</p>}
        <div className="p-4">{children}</div>
      </details>
    );
  }

  return (
    <section className={[surfaceClassName, className].filter(Boolean).join(" ")}>
      {(title || hint || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 px-4 pt-3.5">
          <div className="min-w-0">
            {title && <h3 className="text-13 font-semibold text-primary">{title}</h3>}
            {hint && <p className="mt-0.5 text-11 text-tertiary">{hint}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}
