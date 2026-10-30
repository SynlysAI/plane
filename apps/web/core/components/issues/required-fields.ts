/** Administrative work-item required-field helpers shared by inline editors. */

export type TRequiredIssueField = "module_ids" | "label_ids";

export const REQUIRED_FIELD_MESSAGES: Record<TRequiredIssueField, string> = {
  module_ids: "模块为必选项。",
  label_ids: "标签为必选项。",
};

export const REQUIRED_FIELD_LABELS: Record<TRequiredIssueField, string> = {
  module_ids: "模块",
  label_ids: "标签",
};

const REQUIRED_FIELD_GUIDANCE = "请在完整创建窗口中补充必填项。";

/**
 * List required fields that are missing from a work item payload.
 *
 * Args:
 *   project: Project details carrying the required-field switches.
 *   payload: Partial work item payload to validate.
 *
 * Returns:
 *   Required field keys that are enabled for the administrative project but empty.
 */
export function getMissingRequiredIssueFields(
  project: { is_research_project?: boolean; is_module_required?: boolean; is_label_required?: boolean } | undefined,
  payload: { module_ids?: string[] | null; label_ids?: string[] | null }
): TRequiredIssueField[] {
  if (!project || project.is_research_project !== false) return [];
  return (Object.keys(REQUIRED_FIELD_MESSAGES) as TRequiredIssueField[]).filter((field) =>
    isRequiredSelectionMissing(project, field, payload[field])
  );
}

/**
 * Format a work item create error, surfacing backend required-field messages.
 *
 * Args:
 *   error: Error thrown by the API service, usually the response data object.
 *   fallback: Message used when the error carries no readable content.
 *
 * Returns:
 *   A readable toast message, with guidance appended for required-field errors.
 */
export function formatIssueCreateError(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const fieldErrors = (Object.keys(REQUIRED_FIELD_MESSAGES) as TRequiredIssueField[])
      .flatMap((field) => {
        const messages = (error as Record<string, unknown>)[field];
        return Array.isArray(messages) ? messages.filter((item): item is string => typeof item === "string") : [];
      })
      .filter(Boolean);
    if (fieldErrors.length > 0) return `${fieldErrors.join("")}${REQUIRED_FIELD_GUIDANCE}`;
    const readableError = error as { error?: unknown; message?: unknown };
    if (typeof readableError.error === "string" && readableError.error) return readableError.error;
    if (typeof readableError.message === "string" && readableError.message) return readableError.message;
  }
  return fallback;
}

/**
 * Check whether a selection would violate an enabled project required-field rule.
 *
 * Args:
 *   project: Project details carrying the required-field switches.
 *   field: The relation being changed.
 *   value: The complete next selection for that relation.
 *
 * Returns:
 *   True when the rule is enabled and the next selection is empty.
 */
export function isRequiredSelectionMissing(
  project: { is_module_required?: boolean; is_label_required?: boolean } | undefined,
  field: TRequiredIssueField,
  value: string[] | null | undefined
): boolean {
  const isRequired = field === "module_ids" ? project?.is_module_required : project?.is_label_required;
  return Boolean(isRequired && (value?.length ?? 0) === 0);
}
