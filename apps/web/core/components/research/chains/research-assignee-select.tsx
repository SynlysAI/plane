"use client";

import { useId } from "react";
import { useTranslation } from "@plane/i18n";
import type { TResearchAssignableUser, TResearchAssignableUserScope } from "@plane/types";

type Props = {
  candidates: TResearchAssignableUser[];
  value: string;
  label: string;
  disabled?: boolean;
  onChange: (userId: string) => void;
};

const SCOPE_ORDER: TResearchAssignableUserScope[] = ["ORG_SCOPE", "COLLABORATOR"];

/**
 * Build the compact organisation and research identity shown beside a candidate.
 *
 * Args:
 *   candidate: One user returned by the chain assignable-users API.
 *   t: Translation function for stable labels.
 *
 * Returns:
 *   A plain-text identity description for the option label.
 */
function candidateIdentity(candidate: TResearchAssignableUser, t: (key: string) => string) {
  const org = candidate.org_unit_name || t("research.chain_tasks.assignee_no_org");
  const role = candidate.org_role ? t(`research.chain_tasks.roles.${candidate.org_role.toLowerCase()}`) : "";
  const identity = candidate.is_primary
    ? t("research.chain_tasks.primary_identity")
    : t("research.chain_tasks.collaborator_identity");
  return [org, role, identity].filter(Boolean).join(" · ");
}

/**
 * Render only API-returned assignable users, grouped by server boundary scope.
 *
 * Args:
 *   candidates: Exact assignable-users API collection.
 *   value: Selected user id.
 *   label: Accessible field label.
 *   disabled: Whether task assignment is currently editable.
 *   onChange: Consumer callback receiving only a candidate user id.
 */
export function ResearchAssigneeSelect({ candidates, value, label, disabled = false, onChange }: Props) {
  const { t } = useTranslation();
  const selectId = useId();

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={selectId} className="text-11 text-tertiary">
        {label}
      </label>
      <select
        id={selectId}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-md border border-subtle bg-surface-1 px-3 py-2 text-12 text-primary disabled:text-tertiary"
      >
        <option value="">{t("research.chain_tasks.unassigned")}</option>
        {SCOPE_ORDER.map((scope) => {
          const scoped = candidates.filter((candidate) => candidate.scope === scope);
          if (!scoped.length) return null;
          return (
            <optgroup
              key={scope}
              label={t(`research.chain_tasks.scopes.${scope === "ORG_SCOPE" ? "org_scope" : "collaborator"}`)}
            >
              {scoped.map((candidate) => (
                <option key={`${scope}-${candidate.user_id}`} value={candidate.user_id}>
                  {candidate.display_name} — {candidateIdentity(candidate, t)}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      <p className="text-11 text-tertiary">{t("research.chain_tasks.candidate_scope_hint")}</p>
    </div>
  );
}
