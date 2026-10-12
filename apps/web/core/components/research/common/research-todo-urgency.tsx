"use client";

import { useTranslation } from "@plane/i18n";
import type { TResearchTodoUrgency } from "@plane/types";

const URGENCY_LABEL_KEYS: Record<TResearchTodoUrgency, string> = {
  OVERDUE: "research.todo.urgency.overdue",
  DUE_TODAY: "research.todo.urgency.today",
  DUE_SOON: "research.todo.urgency.soon",
  NORMAL: "research.todo.urgency.normal",
};

type Props = {
  dueAt: string | null;
  urgency?: TResearchTodoUrgency;
  now?: string;
};

/** Resolve a todo's urgency from immutable due-time inputs. */
function resolveUrgency(dueAt: string | null, now: string, fallback?: TResearchTodoUrgency): TResearchTodoUrgency {
  if (fallback) return fallback;
  if (!dueAt) return "NORMAL";
  const dueTime = new Date(dueAt).getTime();
  const currentTime = new Date(now).getTime();
  if (Number.isNaN(dueTime) || Number.isNaN(currentTime)) return "NORMAL";
  if (dueTime < currentTime) return "OVERDUE";
  if (new Date(dueTime).toDateString() === new Date(currentTime).toDateString()) return "DUE_TODAY";
  return dueTime - currentTime <= 72 * 3600000 ? "DUE_SOON" : "NORMAL";
}

/** Format a stable clock time without adding another date dependency. */
function formatClock(value: Date) {
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

/** Render a textual due countdown; color is always secondary to the words. */
export function ResearchTodoUrgency({ dueAt, urgency, now }: Props) {
  const { t } = useTranslation();
  const currentTime = now ?? new Date().toISOString();
  const resolved = resolveUrgency(dueAt, currentTime, urgency);
  const dueTime = dueAt ? new Date(dueAt).getTime() : Number.NaN;
  const current = new Date(currentTime).getTime();
  let countdown = "";

  if (!Number.isNaN(dueTime) && resolved !== "NORMAL") {
    const diffHours = Math.abs(dueTime - current) / 3600000;
    const days = Math.max(1, Math.floor(diffHours / 24));
    if (resolved === "OVERDUE") {
      countdown = diffHours < 48 ? ` ${Math.max(1, Math.round(diffHours))} 小时` : ` ${days} 天`;
    } else if (resolved === "DUE_TODAY") {
      countdown = ` ${formatClock(new Date(dueTime))}`;
    } else {
      countdown = diffHours < 48 ? ` 剩 ${Math.max(1, Math.round(diffHours))} 小时` : ` 剩 ${days} 天`;
    }
  }

  const className =
    resolved === "OVERDUE" || resolved === "DUE_TODAY"
      ? "border-danger-strong/40 text-danger-primary"
      : "border-subtle text-secondary";

  return (
    <span className={`rounded border bg-surface-1 px-1.5 py-0.5 text-11 ${className}`}>
      {t(URGENCY_LABEL_KEYS[resolved])}
      {countdown}
    </span>
  );
}
