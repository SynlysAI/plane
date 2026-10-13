import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@plane/propel/button";

/** Consistent field alignment and wrapping across research lists and management. */
export function ResearchBrowseToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-end gap-x-3 gap-y-3 border-b border-subtle pb-4">{children}</div>
  );
}

export function ResearchBrowseHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
      <h2 className="text-16 font-semibold text-primary">{title}</h2>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function ResearchBrowseRefresh({ onRefresh, disabled }: { onRefresh: () => void; disabled?: boolean }) {
  return (
    <Button
      variant="secondary"
      size="xl"
      className="w-8 shrink-0 px-0"
      aria-label="刷新"
      title="刷新"
      disabled={disabled}
      onClick={onRefresh}
    >
      <RefreshCw aria-hidden="true" className="size-4" />
    </Button>
  );
}
