/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import {
  REPORT_TYPE_LABELS,
  REPORT_TYPES,
  STAGE_MATERIAL_TYPES,
  STAGE_TYPE_LABELS,
  STAGE_TYPES,
  stageMaterialLabelKey,
} from "@plane/constants";
import type { TReportType } from "@plane/constants";
import type { TReportTemplate, TReportTemplateSection } from "@plane/types";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash } from "lucide-react";
// components
import { getResearchErrorKey } from "@/components/research/common/error-messages";
import {
  ResearchFilterToolbar,
  ResearchListSurface,
  ResearchTableSurface,
} from "@/components/research/common/research-data-surface";
import { formatResearchDateTime } from "@/components/research/common/research-format";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
};

type TemplateDraft = {
  id?: string;
  name: string;
  scope: "REPORT" | "STAGE_MATERIAL";
  reportType: TReportType;
  stage: string;
  materialType: string;
  guidance: string;
  sections: TReportTemplateSection[];
  isDefault: boolean;
  isActive: boolean;
};

type TemplateTargetPayload = {
  scope: TemplateDraft["scope"];
  report_type: TReportType;
  stage: string;
  material_type: string;
};

const EMPTY_DRAFT: TemplateDraft = {
  name: "",
  scope: "REPORT",
  reportType: "WEEKLY",
  stage: "PRE_OPENING",
  materialType: "TOPIC_DESCRIPTION",
  guidance: "",
  sections: [],
  isDefault: false,
  isActive: true,
};

/** Create a blank section with a stable identifier unused by the current draft. */
function makeSection(existingSections: TReportTemplateSection[]): TReportTemplateSection {
  const usedIds = new Set(existingSections.map((section) => section.id));
  let sequence = existingSections.length + 1;
  let id = `section-${sequence}`;
  while (usedIds.has(id)) {
    sequence += 1;
    id = `section-${sequence}`;
  }
  return {
    id,
    title: "",
    guidance: "",
    required: true,
  };
}

/** Build the backend target payload from the local editing state. */
function targetPayload(draft: TemplateDraft): TemplateTargetPayload {
  if (draft.scope === "REPORT") {
    return {
      scope: draft.scope,
      report_type: draft.reportType,
      stage: "",
      material_type: "",
    };
  }
  return {
    scope: draft.scope,
    report_type: "WEEKLY",
    stage: draft.stage,
    material_type: draft.materialType,
  };
}

/** Report template maintenance with structured authoring sections. */
export const ResearchTemplateList = observer(function ResearchTemplateList({ workspaceSlug }: Props) {
  const { t, currentLocale } = useTranslation();
  const research = useResearch();
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const templates = research.getReportTemplates(workspaceSlug);
  const materialTypes = useMemo(
    () => STAGE_MATERIAL_TYPES[draft?.stage as keyof typeof STAGE_MATERIAL_TYPES] ?? [],
    [draft?.stage]
  );

  useEffect(() => {
    void research
      .fetchReportTemplates(workspaceSlug, { include_inactive: "true" })
      .catch((error) => setErrorKey(getResearchErrorKey(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug]);

  const startCreate = useCallback(() => {
    setDraft({ ...EMPTY_DRAFT, sections: [makeSection([])] });
    setFormError(null);
  }, []);

  const startEdit = useCallback((template: TReportTemplate) => {
    setDraft({
      id: template.id,
      name: template.name,
      scope: template.scope === "STAGE_MATERIAL" ? "STAGE_MATERIAL" : "REPORT",
      reportType: template.report_type,
      stage: template.stage || "PRE_OPENING",
      materialType: template.material_type || "TOPIC_DESCRIPTION",
      guidance: template.sections_json?.guidance ?? "",
      sections: template.sections_json?.sections ?? [],
      isDefault: template.is_default,
      isActive: template.is_active,
    });
    setFormError(null);
  }, []);

  const updateDraft = useCallback((patch: Partial<TemplateDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const updateSection = useCallback((index: number, patch: Partial<TReportTemplateSection>) => {
    setDraft((current) => {
      if (!current) return current;
      const sections = current.sections.map((section, position) =>
        position === index ? { ...section, ...patch } : section
      );
      return { ...current, sections };
    });
  }, []);

  const moveSection = useCallback((index: number, direction: -1 | 1) => {
    setDraft((current) => {
      if (!current) return current;
      const next = index + direction;
      if (next < 0 || next >= current.sections.length) return current;
      const sections = [...current.sections];
      [sections[index], sections[next]] = [sections[next], sections[index]];
      return { ...current, sections };
    });
  }, []);

  const removeSection = useCallback((index: number) => {
    setDraft((current) => {
      if (!current) return current;
      return { ...current, sections: current.sections.filter((_, position) => position !== index) };
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft || saving) return;
    const normalizedSections = draft.sections.map((section) => ({
      ...section,
      id: section.id.trim(),
      title: section.title.trim(),
      guidance: section.guidance.trim(),
      max_chars: section.max_chars === undefined || section.max_chars === null ? undefined : Number(section.max_chars),
    }));
    if (!draft.name.trim()) {
      setFormError(t("research.templates.errors.name_required"));
      return;
    }
    if (draft.scope === "STAGE_MATERIAL" && (!draft.stage || !draft.materialType)) {
      setFormError(t("research.templates.errors.target_required"));
      return;
    }
    if (
      normalizedSections.some(
        (section) =>
          !section.id ||
          !section.title ||
          !section.guidance ||
          (section.max_chars !== undefined && section.max_chars <= 0)
      )
    ) {
      setFormError(t("research.templates.errors.section_required"));
      return;
    }

    const payload = {
      name: draft.name.trim(),
      ...targetPayload(draft),
      is_default: draft.isDefault && draft.isActive,
      is_active: draft.isActive,
      sections_json: {
        version: 1,
        guidance: draft.guidance.trim(),
        sections: normalizedSections,
      } as TReportTemplate["sections_json"],
    };

    setSaving(true);
    try {
      if (draft.id) {
        await research.updateReportTemplate(workspaceSlug, draft.id, payload);
      } else {
        await research.createReportTemplate(workspaceSlug, payload);
      }
      setDraft(null);
      setFormError(null);
      setErrorKey(null);
    } catch (error) {
      setErrorKey(getResearchErrorKey(error));
    } finally {
      setSaving(false);
    }
  }, [draft, research, saving, t, workspaceSlug]);

  const handleToggleDefault = useCallback(
    async (template: TReportTemplate, nextDefault: boolean) => {
      try {
        await research.updateReportTemplate(workspaceSlug, template.id, {
          is_default: nextDefault,
          is_active: nextDefault ? true : template.is_active,
        });
        setErrorKey(null);
      } catch (error) {
        setErrorKey(getResearchErrorKey(error));
      }
    },
    [research, workspaceSlug]
  );

  const handleDelete = useCallback(
    async (template: TReportTemplate) => {
      if (!window.confirm(t("research.templates.delete_confirm", { name: template.name }))) return;
      try {
        await research.deleteReportTemplate(workspaceSlug, template.id);
        if (draft?.id === template.id) setDraft(null);
        setErrorKey(null);
      } catch (error) {
        setErrorKey(getResearchErrorKey(error));
      }
    },
    [draft?.id, research, t, workspaceSlug]
  );

  /** Render a calm target label without relying on color coding. */
  const targetLabel = useCallback(
    (template: TReportTemplate) => {
      if (template.scope === "STAGE_MATERIAL") {
        return `${t(STAGE_TYPE_LABELS[template.stage as keyof typeof STAGE_TYPE_LABELS])} · ${t(
          stageMaterialLabelKey(template.material_type)
        )}`;
      }
      return t(REPORT_TYPE_LABELS[template.report_type]);
    },
    [t]
  );

  return (
    <ResearchListSurface>
      {(errorKey || formError) && (
        <div className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
          {formError ? formError : errorKey ? t(errorKey) : null}
        </div>
      )}

      <ResearchFilterToolbar>
        <div className="flex-1" />
        <Button variant="primary" size="xl" onClick={startCreate}>
          <Plus className="mr-1 size-3.5" />
          {t("research.templates.create")}
        </Button>
      </ResearchFilterToolbar>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(280px,5fr)]">
        <ResearchTableSurface>
          <Table className="min-w-120">
            <TableHeader>
              <TableRow className="text-tertiary">
                <TableHead>{t("research.templates.columns.name")}</TableHead>
                <TableHead>{t("research.templates.columns.target")}</TableHead>
                <TableHead>{t("research.templates.columns.sections")}</TableHead>
                <TableHead>{t("research.templates.columns.default")}</TableHead>
                <TableHead>{t("research.templates.columns.status")}</TableHead>
                <TableHead>{t("research.templates.columns.updated_at")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((template) => (
                <TableRow key={template.id} className={draft?.id === template.id ? "bg-surface-2" : undefined}>
                  <TableCell className="text-secondary">
                    <span className="block font-medium">{template.name}</span>
                  </TableCell>
                  <TableCell className="text-tertiary">{targetLabel(template)}</TableCell>
                  <TableCell className="text-tertiary">{template.sections_json?.sections.length ?? 0}</TableCell>
                  <TableCell>
                    <input
                      type="checkbox"
                      checked={template.is_default}
                      onChange={(event) => void handleToggleDefault(template, event.target.checked)}
                    />
                  </TableCell>
                  <TableCell className="text-tertiary">
                    {template.is_active ? t("research.templates.active") : t("research.templates.inactive")}
                  </TableCell>
                  <TableCell className="text-tertiary">
                    {formatResearchDateTime(template.updated_at, currentLocale)}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="inline-flex items-center justify-end gap-1">
                      <Button variant="ghost" size="sm" onClick={() => startEdit(template)}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => void handleDelete(template)}>
                        <Trash className="size-3.5" />
                      </Button>
                    </span>
                  </TableCell>
                </TableRow>
              ))}
              {!templates.length && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-tertiary">
                    {t("research.templates.empty")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ResearchTableSurface>

        {draft && (
          <section className="flex flex-col gap-4 border border-subtle bg-surface-1 p-4">
            <header className="border-b border-subtle pb-3">
              <h3 className="text-15 font-semibold text-primary">
                {draft.id ? t("research.templates.edit_title") : t("research.templates.create_title")}
              </h3>
              <p className="mt-1 text-12 text-tertiary">{t("research.templates.editor_hint")}</p>
            </header>

            <div className="grid gap-3">
              <label className="grid gap-1 text-12 text-secondary">
                <span>{t("research.templates.columns.name")}</span>
                <input
                  className="rounded-md border border-subtle bg-canvas px-2 py-1.5 text-13 text-primary"
                  aria-label={t("research.templates.columns.name")}
                  value={draft.name}
                  onChange={(event) => updateDraft({ name: event.target.value })}
                />
              </label>

              <label className="grid gap-1 text-12 text-secondary">
                <span>{t("research.templates.columns.target")}</span>
                <select
                  className="rounded-md border border-subtle bg-canvas px-2 py-1.5 text-13 text-primary"
                  value={draft.scope}
                  onChange={(event) => updateDraft({ scope: event.target.value as TemplateDraft["scope"] })}
                >
                  <option value="REPORT">{t("research.templates.scopes.report")}</option>
                  <option value="STAGE_MATERIAL">{t("research.templates.scopes.stage_material")}</option>
                </select>
              </label>

              {draft.scope === "REPORT" ? (
                <label className="grid gap-1 text-12 text-secondary">
                  <span>{t("research.templates.columns.type")}</span>
                  <select
                    className="rounded-md border border-subtle bg-canvas px-2 py-1.5 text-13 text-primary"
                    value={draft.reportType}
                    onChange={(event) => updateDraft({ reportType: event.target.value as TReportType })}
                  >
                    {REPORT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {t(REPORT_TYPE_LABELS[type])}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1 text-12 text-secondary">
                    <span>{t("research.templates.columns.stage")}</span>
                    <select
                      className="rounded-md border border-subtle bg-canvas px-2 py-1.5 text-13 text-primary"
                      value={draft.stage}
                      onChange={(event) => updateDraft({ stage: event.target.value, materialType: "" })}
                    >
                      {STAGE_TYPES.map((stage) => (
                        <option key={stage} value={stage}>
                          {t(STAGE_TYPE_LABELS[stage])}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-12 text-secondary">
                    <span>{t("research.templates.columns.material")}</span>
                    <select
                      className="rounded-md border border-subtle bg-canvas px-2 py-1.5 text-13 text-primary"
                      value={draft.materialType}
                      onChange={(event) => updateDraft({ materialType: event.target.value })}
                    >
                      <option value="">{t("research.templates.select_material")}</option>
                      {materialTypes.map((materialType) => (
                        <option key={materialType} value={materialType}>
                          {t(stageMaterialLabelKey(materialType))}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}

              <label className="grid gap-1 text-12 text-secondary">
                <span>{t("research.templates.guidance")}</span>
                <textarea
                  className="min-h-20 rounded-md border border-subtle bg-canvas px-2 py-1.5 text-13 leading-6 text-primary"
                  aria-label={t("research.templates.guidance")}
                  value={draft.guidance}
                  onChange={(event) => updateDraft({ guidance: event.target.value })}
                />
              </label>
            </div>

            <div className="flex flex-wrap gap-4 border-y border-subtle py-3 text-12 text-secondary">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.isDefault}
                  onChange={(event) => updateDraft({ isDefault: event.target.checked })}
                />
                {t("research.templates.set_default")}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.isActive}
                  onChange={(event) => updateDraft({ isActive: event.target.checked })}
                />
                {t("research.templates.active")}
              </label>
            </div>

            <div className="grid gap-3">
              <div className="flex items-center justify-between">
                <h4 className="text-13 font-semibold text-primary">{t("research.templates.sections")}</h4>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => updateDraft({ sections: [...draft.sections, makeSection(draft.sections)] })}
                >
                  <Plus className="mr-1 size-3.5" />
                  {t("research.templates.add_section")}
                </Button>
              </div>

              {draft.sections.map((section, index) => (
                <article key={section.id} className="border-b border-subtle pb-3">
                  <div className="flex items-center justify-between gap-2 pb-2">
                    <span className="text-11 text-tertiary">{index + 1}</span>
                    <span className="flex items-center gap-0.5">
                      <Button variant="ghost" size="sm" disabled={index === 0} onClick={() => moveSection(index, -1)}>
                        <ArrowUp className="size-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={index === draft.sections.length - 1}
                        onClick={() => moveSection(index, 1)}
                      >
                        <ArrowDown className="size-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => removeSection(index)}>
                        <Trash className="size-3.5" />
                      </Button>
                    </span>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[1fr_120px]">
                    <label className="grid gap-1 text-11 text-tertiary">
                      <span>{t("research.templates.section_title")}</span>
                      <input
                        className="rounded-md border border-subtle bg-canvas px-2 py-1.5 text-12 text-primary"
                        aria-label={t("research.templates.section_title")}
                        value={section.title}
                        onChange={(event) => updateSection(index, { title: event.target.value })}
                      />
                    </label>
                    <label className="grid gap-1 text-11 text-tertiary">
                      <span>{t("research.templates.section_id")}</span>
                      <input
                        className="font-mono rounded-md border border-subtle bg-canvas px-2 py-1.5 text-12 text-primary"
                        aria-label={t("research.templates.section_id")}
                        value={section.id}
                        onChange={(event) => updateSection(index, { id: event.target.value })}
                      />
                    </label>
                  </div>
                  <label className="mt-2 grid gap-1 text-11 text-tertiary">
                    <span>{t("research.templates.section_guidance")}</span>
                    <textarea
                      className="min-h-16 rounded-md border border-subtle bg-canvas px-2 py-1.5 text-12 leading-5 text-primary"
                      aria-label={t("research.templates.section_guidance")}
                      value={section.guidance}
                      onChange={(event) => updateSection(index, { guidance: event.target.value })}
                    />
                  </label>
                  <div className="mt-2 flex flex-wrap items-end gap-4">
                    <label className="flex items-center gap-2 text-11 text-secondary">
                      <input
                        type="checkbox"
                        checked={section.required}
                        onChange={(event) => updateSection(index, { required: event.target.checked })}
                      />
                      {t("research.templates.required")}
                    </label>
                    <label className="grid gap-1 text-11 text-tertiary">
                      <span>{t("research.templates.max_chars")}</span>
                      <input
                        type="number"
                        min={1}
                        className="w-24 rounded-md border border-subtle bg-canvas px-2 py-1.5 text-12 text-primary"
                        aria-label={t("research.templates.max_chars")}
                        value={section.max_chars ?? ""}
                        onChange={(event) =>
                          updateSection(index, {
                            max_chars: event.target.value ? Number(event.target.value) : undefined,
                          })
                        }
                      />
                    </label>
                  </div>
                </article>
              ))}
            </div>

            <div className="border-t border-subtle pt-3">
              <h4 className="text-13 font-semibold text-primary">{t("research.templates.preview")}</h4>
              <div className="mt-2 bg-canvas px-3 py-2 text-12 leading-6 text-secondary">
                {draft.guidance && <p className="mb-2 border-l border-subtle pl-2 text-tertiary">{draft.guidance}</p>}
                {draft.sections.map((section) => (
                  <div key={`${section.id}-preview`} className="border-b border-subtle py-2 last:border-b-0">
                    <p className="font-semibold text-primary">{section.title || t("research.templates.untitled")}</p>
                    <p className="text-tertiary">{section.guidance}</p>
                    <p className="text-tertiary">
                      {section.required ? t("research.templates.required") : t("research.templates.optional")}
                      {section.max_chars ? ` · ${t("research.templates.max_chars")} ${section.max_chars}` : ""}
                    </p>
                  </div>
                ))}
                {!draft.sections.length && <p className="text-tertiary">{t("research.templates.no_sections")}</p>}
              </div>
            </div>

            <div className="flex justify-end gap-2 border-t border-subtle pt-3">
              <Button variant="secondary" size="sm" onClick={() => setDraft(null)}>
                {t("research.common.cancel")}
              </Button>
              <Button variant="primary" size="sm" disabled={saving} onClick={() => void handleSave()}>
                {saving ? t("research.templates.saving") : t("research.common.save")}
              </Button>
            </div>
          </section>
        )}
      </div>
    </ResearchListSurface>
  );
});
