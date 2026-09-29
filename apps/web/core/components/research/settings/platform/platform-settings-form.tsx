/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { REPORT_VISIBILITIES, REPORT_VISIBILITY_LABELS } from "@plane/constants";
import type { TReportVisibility } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import type { TResearchProfileCategory, TWorkspaceResearchSetting } from "@plane/types";
import { Input } from "@plane/ui";
// components
import { getResearchErrorKey } from "@/components/research/common/error-messages";
import { ResearchDetailSurface } from "@/components/research/common/research-data-surface";
// hooks
import { useResearch } from "@/hooks/store/use-research";
// services
import { ResearchPlatformService } from "@/services/research/platform.service";

type Props = {
  workspaceSlug: string;
};

const TOGGLES: { field: keyof TWorkspaceResearchSetting; labelKey: string }[] = [
  { field: "module_enabled", labelKey: "research.platform.module_enabled" },
  { field: "org_enabled", labelKey: "research.platform.org_enabled" },
  { field: "report_enabled", labelKey: "research.platform.report_enabled" },
  { field: "approval_enabled", labelKey: "research.platform.approval_enabled" },
  { field: "research_chain_enabled", labelKey: "research.platform.research_chain_enabled" },
  { field: "research_ia_v2", labelKey: "research.platform.research_ia_v2" },
];

const LIMITS: { field: keyof TWorkspaceResearchSetting; labelKey: string }[] = [
  { field: "image_max_mb", labelKey: "research.platform.image_max_mb" },
  { field: "pdf_max_mb", labelKey: "research.platform.pdf_max_mb" },
  { field: "markdown_max_mb", labelKey: "research.platform.markdown_max_mb" },
  { field: "audit_retention_days", labelKey: "research.platform.audit_retention_days" },
];

/** 与数字框同高，去掉默认内边距，避免字形被底边裁成半行。 */
const RESEARCH_FIELD_INPUT_CLASS = [
  "box-border h-9 w-full min-w-0",
  "overflow-x-auto overflow-y-hidden",
  "px-3 py-0 text-13 leading-8",
].join(" ");

const platformService = new ResearchPlatformService();
const MAIN_PI_LOOKUP_DELAY_MS = 300;

export type TMainPiResolvedName = {
  state: "hidden" | "resolved" | "missing";
  name: string | null;
};

/**
 * 根据已保存姓名或查询结果给出主 PI 显示名。
 *
 * Args:
 *     input: 当前输入、已保存任命，以及可选的查询结果。
 *
 * Returns:
 *     空输入或查询尚未返回时隐藏；有显示名时返回该名字；否则标记为未找到。
 */
export function resolveMainPiName(input: {
  value: string;
  savedId: string | null;
  savedName: string | null;
  lookup: { found: boolean; name: string | null } | null;
}): TMainPiResolvedName {
  const value = input.value.trim();
  if (!value) return { state: "hidden", name: null };
  const savedId = (input.savedId ?? "").trim();
  if (value !== savedId && input.lookup === null) return { state: "hidden", name: null };
  const candidate = (value === savedId ? input.savedName : input.lookup?.name) ?? "";
  const name = candidate.trim();
  if (!name || name === value || (value !== savedId && !input.lookup?.found)) return { state: "missing", name: null };
  return { state: "resolved", name };
}

const REPORTER_CATEGORIES = [
  "STUDENT",
  "POSTDOC",
  "ADVISOR",
  "PI",
  "STAFF",
  "OTHER",
] as const satisfies readonly TResearchProfileCategory[];

/**
 * Research platform configuration: module switches, upload limits and the
 * default visibility policy (P0-CFG-01 ~ P0-CFG-08, P0-UI-08).
 */
export const ResearchPlatformSettingsForm = observer(function ResearchPlatformSettingsForm({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const [draft, setDraft] = useState<TWorkspaceResearchSetting | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [savedMainPi, setSavedMainPi] = useState<{ id: string | null; name: string | null }>({ id: null, name: null });
  const [mainPiName, setMainPiName] = useState<TMainPiResolvedName>({ state: "hidden", name: null });

  const rememberSettings = useCallback((settings: TWorkspaceResearchSetting | null) => {
    setDraft(settings);
    setSavedMainPi({ id: settings?.main_pi ?? null, name: settings?.main_pi_name ?? null });
  }, []);

  useEffect(() => {
    void (async () => {
      const settings = await research.fetchSettings(workspaceSlug);
      if (settings) rememberSettings(settings);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rememberSettings, workspaceSlug]);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const payload = {
        module_enabled: draft.module_enabled,
        org_enabled: draft.org_enabled,
        report_enabled: draft.report_enabled,
        approval_enabled: draft.approval_enabled,
        research_chain_enabled: Boolean(draft.research_chain_enabled),
        research_ia_v2: Boolean(draft.research_ia_v2),
        default_report_visibility: draft.default_report_visibility,
        weekly_default_visibility: draft.weekly_default_visibility ?? null,
        monthly_default_visibility: draft.monthly_default_visibility ?? null,
        image_max_mb: draft.image_max_mb,
        pdf_max_mb: draft.pdf_max_mb,
        markdown_max_mb: draft.markdown_max_mb,
        audit_retention_days: draft.audit_retention_days,
        timezone: draft.timezone,
        required_reporter_categories: draft.required_reporter_categories,
        ...(research.identity?.user.is_system_admin ? { main_pi: draft.main_pi } : {}),
      };
      const updated = await research.updateSettings(workspaceSlug, payload);
      if (updated) rememberSettings(updated);
      await research.fetchIdentity(workspaceSlug).catch(() => undefined);
      setSavedAt(Date.now());
      setErrorKey(null);
    } catch (error) {
      setErrorKey(getResearchErrorKey(error));
    } finally {
      setSaving(false);
    }
  }, [draft, rememberSettings, research, workspaceSlug]);

  useEffect(() => {
    const value = draft?.main_pi ?? "";
    if (!research.identity?.user.is_system_admin) {
      setMainPiName({ state: "hidden", name: null });
      return;
    }
    const immediate = resolveMainPiName({
      value,
      savedId: savedMainPi.id,
      savedName: savedMainPi.name,
      lookup: null,
    });
    if (value.trim() === (savedMainPi.id ?? "").trim()) {
      setMainPiName(immediate);
      return;
    }
    setMainPiName({ state: "hidden", name: null });
    const lookupValue = value.trim();
    if (!lookupValue) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await platformService.lookupMainPi(workspaceSlug, lookupValue);
          if (cancelled) return;
          setMainPiName(
            resolveMainPiName({
              value: lookupValue,
              savedId: savedMainPi.id,
              savedName: savedMainPi.name,
              lookup: {
                found: Boolean(result?.lookup_user_found),
                name: result?.lookup_user_name ?? null,
              },
            })
          );
        } catch {
          if (!cancelled) setMainPiName({ state: "missing", name: null });
        }
      })();
    }, MAIN_PI_LOOKUP_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draft?.main_pi, research.identity?.user.is_system_admin, savedMainPi.id, savedMainPi.name, workspaceSlug]);

  if (!draft) {
    return <p className="p-5 text-13 text-tertiary">{t("research.common.loading")}</p>;
  }

  return (
    <div className="flex h-full min-w-0 flex-col gap-4 overflow-x-hidden overflow-y-auto bg-canvas p-5">
      {errorKey && (
        <div className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
          {t(errorKey)}
        </div>
      )}
      {savedAt && !errorKey && <p className="text-12 text-tertiary">{t("research.common.saved")}</p>}

      <ResearchDetailSurface title={t("research.platform.switches")}>
        <div className="mt-3 flex flex-col gap-3">
          {TOGGLES.map((item) => (
            <label key={item.field} className="flex items-center justify-between gap-4 text-12 text-secondary">
              <span>{t(item.labelKey)}</span>
              <input
                type="checkbox"
                checked={Boolean(draft[item.field])}
                onChange={(event) => setDraft({ ...draft, [item.field]: event.target.checked })}
              />
            </label>
          ))}
        </div>
      </ResearchDetailSurface>

      <ResearchDetailSurface title={t("research.platform.visibility")}>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          {(
            [
              ["default_report_visibility", "research.platform.default_visibility"],
              ["weekly_default_visibility", "research.platform.weekly_visibility"],
              ["monthly_default_visibility", "research.platform.monthly_visibility"],
            ] as const
          ).map(([field, labelKey]) => (
            <label key={field} className="flex flex-col gap-1 text-12 text-secondary">
              <span>{t(labelKey)}</span>
              <select
                className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-12 text-primary"
                value={(draft[field] as string | null) ?? ""}
                onChange={(event) => setDraft({ ...draft, [field]: event.target.value || null })}
              >
                {field !== "default_report_visibility" && <option value="">{t("research.platform.inherit")}</option>}
                {REPORT_VISIBILITIES.map((visibility: TReportVisibility) => (
                  <option key={visibility} value={visibility}>
                    {t(REPORT_VISIBILITY_LABELS[visibility])}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <label className="mt-3 flex flex-col gap-1 text-12 text-secondary">
          <span>{t("research.platform.timezone")}</span>
          <Input
            className={RESEARCH_FIELD_INPUT_CLASS}
            value={draft.timezone ?? ""}
            placeholder="Asia/Shanghai"
            onChange={(event) => setDraft({ ...draft, timezone: event.target.value || null })}
          />
        </label>
      </ResearchDetailSurface>

      <ResearchDetailSurface
        title={t("research.platform.reporting_scope")}
        hint={t("research.platform.reporting_scope_hint")}
      >
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {REPORTER_CATEGORIES.map((category) => (
            <label key={category} className="flex items-center gap-2 text-12 text-secondary">
              <input
                type="checkbox"
                checked={draft.required_reporter_categories.includes(category)}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    required_reporter_categories: event.target.checked
                      ? [...draft.required_reporter_categories, category]
                      : draft.required_reporter_categories.filter((item) => item !== category),
                  })
                }
              />
              <span>{t(`research.profile_categories.${category.toLowerCase()}`)}</span>
            </label>
          ))}
        </div>
      </ResearchDetailSurface>

      {research.identity?.user.is_system_admin && (
        <ResearchDetailSurface
          className="min-w-0"
          title={t("research.platform.main_pi")}
          hint={t("research.platform.main_pi_hint")}
        >
          <div className="mt-3 min-w-0">
            <Input
              className={RESEARCH_FIELD_INPUT_CLASS}
              value={draft.main_pi ?? ""}
              placeholder={t("research.platform.main_pi_placeholder")}
              aria-label={t("research.platform.main_pi")}
              onChange={(event) => setDraft({ ...draft, main_pi: event.target.value.trim() || null })}
            />
            {mainPiName.state !== "hidden" && (
              <p className="mt-1 text-11 text-tertiary" data-testid="main-pi-resolved-name">
                {mainPiName.state === "resolved" ? mainPiName.name : t("research.platform.main_pi_unresolved")}
              </p>
            )}
          </div>
        </ResearchDetailSurface>
      )}

      <ResearchDetailSurface title={t("research.platform.limits")}>
        <div className="mt-3 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {LIMITS.map((item) => (
            <label key={item.field} className="flex flex-col gap-1 text-12 text-secondary">
              <span>{t(item.labelKey)}</span>
              <Input
                className={RESEARCH_FIELD_INPUT_CLASS}
                type="number"
                min={0}
                value={String(draft[item.field] ?? 0)}
                onChange={(event) => setDraft({ ...draft, [item.field]: Number(event.target.value) })}
              />
            </label>
          ))}
        </div>
        <p className="mt-2 text-11 text-tertiary">{t("research.platform.limits_hint")}</p>
      </ResearchDetailSurface>

      <div className="sticky bottom-0 flex justify-end bg-canvas py-3">
        <Button variant="primary" size="lg" loading={saving} onClick={() => void handleSave()}>
          {t("research.common.save")}
        </Button>
      </div>
    </div>
  );
});
