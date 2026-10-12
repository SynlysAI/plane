"use client";

import { useId, useMemo, useState } from "react";
import { useTranslation } from "@plane/i18n";
import type { TResearchAssignableUser, TResearchAssignableUserScope } from "@plane/types";

type Props = {
  candidates: TResearchAssignableUser[];
  value: string;
  label: string;
  disabled?: boolean;
  allowClear?: boolean;
  placeholder?: string;
  fullWidth?: boolean;
  menuAlign?: "left" | "right";
  onChange: (userId: string) => void;
};

const SCOPE_ORDER: TResearchAssignableUserScope[] = ["ORG_SCOPE", "COLLABORATOR"];

/**
 * 拼出候选人的组织、角色和身份，供指派弹出层展示。
 *
 * Args:
 *   candidate: 可指派接口返回的一名用户。
 *   t: 稳定文案翻译函数。
 *
 * Returns:
 *   一行纯文本身份说明。
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
 * 用弹出层选择科研组织范围内的单名负责人。
 *
 * Args:
 *   candidates: 可指派接口的原样结果。
 *   value: 当前负责人 id。
 *   label: 字段的无障碍名称。
 *   disabled: 当前是否允许改指派。
 *   allowClear: 是否允许选回未指派。已有负责人时应为 false。
 *   placeholder: 未选择时的提示。缺省时仍显示“未指派”。
 *   fullWidth: 详情属性行需要占满剩余宽度。
 *   menuAlign: 弹出层对齐方式。列表行靠右，详情行靠左。
 *   onChange: 只回传候选人 user id。
 */
export function ResearchAssigneeSelect({
  candidates,
  value,
  label,
  disabled = false,
  allowClear = true,
  placeholder,
  fullWidth = false,
  menuAlign = "right",
  onChange,
}: Props) {
  const { t } = useTranslation();
  const selectId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const selected = candidates.find((candidate) => candidate.user_id === value);
  const emptyLabel = placeholder || t("research.chain_tasks.unassigned");
  const visibleCandidates = useMemo(
    () =>
      candidates.filter((candidate) =>
        [candidate.display_name, candidate.org_unit_name, candidate.org_role]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery)
      ),
    [candidates, normalizedQuery]
  );

  return (
    <div className="relative min-w-0" data-peek-trigger="">
      <button
        id={selectId}
        type="button"
        aria-label={label}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={`flex h-7 items-center gap-1.5 rounded-sm px-1.5 text-left text-12 hover:bg-surface-2 disabled:cursor-default disabled:hover:bg-transparent ${
          fullWidth ? "w-full" : "max-w-40"
        } ${selected ? "text-secondary" : placeholder ? "text-placeholder" : "text-secondary"}`}
      >
        {selected ? (
          <span className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-2 text-10 text-secondary">
            {selected.display_name.slice(0, 1)}
          </span>
        ) : null}
        <span className="truncate">{selected?.display_name || emptyLabel}</span>
      </button>
      {open && !disabled && (
        <div
          role="listbox"
          aria-label={label}
          className={`absolute top-8 z-20 w-72 rounded-md border border-subtle bg-surface-1 p-2 shadow-[0_8px_24px_rgba(37,37,34,0.08)] ${
            menuAlign === "left" ? "left-0" : "right-0"
          }`}
        >
          <input
            type="search"
            value={query}
            aria-label={t("research.chain_tasks.search_assignee")}
            placeholder={t("research.chain_tasks.search_assignee")}
            onChange={(event) => setQuery(event.target.value)}
            className="mb-2 w-full rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
          />
          {allowClear && (
            <button
              type="button"
              role="option"
              aria-selected={!value}
              className="block w-full rounded-sm px-2 py-1.5 text-left text-12 text-secondary hover:bg-surface-2"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              {t("research.chain_tasks.unassigned")}
            </button>
          )}
          {SCOPE_ORDER.map((scope) => {
            const scoped = visibleCandidates.filter((candidate) => candidate.scope === scope);
            if (!scoped.length) return null;
            return (
              <div
                key={scope}
                role="group"
                aria-label={t(`research.chain_tasks.scopes.${scope === "ORG_SCOPE" ? "org_scope" : "collaborator"}`)}
                className="mt-1"
              >
                <p className="px-2 py-1 text-11 text-tertiary">
                  {t(`research.chain_tasks.scopes.${scope === "ORG_SCOPE" ? "org_scope" : "collaborator"}`)}
                </p>
                {scoped.map((candidate) => (
                  <button
                    key={`${scope}-${candidate.user_id}`}
                    type="button"
                    role="option"
                    aria-selected={candidate.user_id === value}
                    className="block w-full rounded-sm px-2 py-1.5 text-left hover:bg-surface-2"
                    onClick={() => {
                      onChange(candidate.user_id);
                      setOpen(false);
                    }}
                  >
                    <span className="block text-12 text-primary">{candidate.display_name}</span>
                    <span className="block truncate text-11 text-tertiary">{candidateIdentity(candidate, t)}</span>
                  </button>
                ))}
              </div>
            );
          })}
          {!visibleCandidates.length && (
            <p className="px-2 py-2 text-11 text-tertiary">{t("research.chain_tasks.no_candidate_match")}</p>
          )}
          <p className="mt-2 px-2 text-11 text-tertiary">{t("research.chain_tasks.candidate_scope_hint")}</p>
        </div>
      )}
    </div>
  );
}
