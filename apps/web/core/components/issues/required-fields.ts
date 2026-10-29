/** Administrative work-item required-field helpers shared by inline editors. */

export type TRequiredIssueField = "module_ids" | "label_ids";

export const REQUIRED_FIELD_MESSAGES: Record<TRequiredIssueField, string> = {
  module_ids: "模块为必选项。",
  label_ids: "标签为必选项。",
};

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
