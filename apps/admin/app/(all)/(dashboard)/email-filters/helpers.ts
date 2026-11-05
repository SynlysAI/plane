import type { TEmailRecipientFilterPolicy } from "@plane/types";

export type TFilterValidationError = {
  error?: string;
  detail?: string | { policy?: string; rules?: string | { index: number; message: string }[] };
};

/** 将接口错误转为可操作的中文提示，避免将内部错误对象显示到界面。 */
export function filterErrorMessage(error: unknown, fallback: string): string {
  const failure = error as TFilterValidationError | undefined;
  if (typeof failure?.detail === "string") return failure.detail;
  if (failure?.detail?.policy) return failure.detail.policy;
  if (typeof failure?.detail?.rules === "string") return failure.detail.rules;
  if (Array.isArray(failure?.detail?.rules)) {
    return failure.detail.rules.map((item) => `第 ${item.index + 1} 条：${item.message}`).join(" ");
  }
  if (failure?.error === "email_recipient_filters_unavailable") return "无法读取邮箱过滤配置，请稍后重试。";
  return fallback;
}

/** 对比已保存策略与草稿，保留规则顺序和稳定标识。 */
export function hasFilterChanges(saved: TEmailRecipientFilterPolicy | null, draft: TEmailRecipientFilterPolicy | null) {
  return saved !== null && draft !== null && JSON.stringify(saved) !== JSON.stringify(draft);
}

export const filterFieldClass =
  "min-h-9 rounded-md border border-subtle bg-surface-1 px-3 py-2 text-14 text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong disabled:opacity-50";

export const filterIconButtonClass =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-md text-secondary hover:bg-layer-2 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-strong disabled:opacity-50";
