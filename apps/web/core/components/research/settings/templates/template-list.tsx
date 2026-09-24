/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useState } from "react";
import { observer } from "mobx-react";
// plane imports
import { REPORT_TYPE_LABELS, REPORT_TYPES } from "@plane/constants";
import type { TReportType } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { Button } from "@plane/propel/button";
import { Input } from "@plane/ui";
// components
import { getResearchErrorKey } from "@/components/research/common/error-messages";
import {
  ResearchFilterToolbar,
  ResearchListSurface,
  ResearchTableSurface,
} from "@/components/research/common/research-data-surface";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
};

/** Report template maintenance (P0-CFG-05). */
export const ResearchTemplateList = observer(function ResearchTemplateList({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const [name, setName] = useState("");
  const [reportType, setReportType] = useState<TReportType>("WEEKLY");
  const [isDefault, setIsDefault] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const templates = research.getReportTemplates(workspaceSlug);

  useEffect(() => {
    void research.fetchReportTemplates(workspaceSlug).catch((error) => setErrorKey(getResearchErrorKey(error)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug]);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) return;
    try {
      await research.createReportTemplate(workspaceSlug, {
        name: name.trim(),
        report_type: reportType,
        is_default: isDefault,
      });
      setName("");
      setIsDefault(false);
      setErrorKey(null);
    } catch (error) {
      setErrorKey(getResearchErrorKey(error));
    }
  }, [isDefault, name, reportType, research, workspaceSlug]);

  const handleToggleDefault = useCallback(
    async (templateId: string, nextDefault: boolean) => {
      try {
        await research.updateReportTemplate(workspaceSlug, templateId, { is_default: nextDefault });
        setErrorKey(null);
      } catch (error) {
        setErrorKey(getResearchErrorKey(error));
      }
    },
    [research, workspaceSlug]
  );

  const handleDelete = useCallback(
    async (templateId: string) => {
      try {
        await research.deleteReportTemplate(workspaceSlug, templateId);
        setErrorKey(null);
      } catch (error) {
        setErrorKey(getResearchErrorKey(error));
      }
    },
    [research, workspaceSlug]
  );

  return (
    <ResearchListSurface>
      {errorKey && (
        <div className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
          {t(errorKey)}
        </div>
      )}

      <ResearchFilterToolbar>
        <Input
          className="!w-64"
          placeholder={t("research.templates.name_placeholder")}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
          value={reportType}
          onChange={(event) => setReportType(event.target.value as TReportType)}
        >
          {REPORT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(REPORT_TYPE_LABELS[type])}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-12 text-secondary">
          <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
          {t("research.templates.set_default")}
        </label>
        <Button variant="primary" size="sm" onClick={() => void handleCreate()}>
          {t("research.common.create")}
        </Button>
      </ResearchFilterToolbar>

      <ResearchTableSurface>
        <Table>
          <TableHeader>
            <TableRow className="text-tertiary">
              <TableHead>{t("research.templates.columns.name")}</TableHead>
              <TableHead>{t("research.templates.columns.type")}</TableHead>
              <TableHead>{t("research.templates.columns.default")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((template) => (
              <TableRow key={template.id}>
                <TableCell className="text-secondary">{template.name}</TableCell>
                <TableCell className="text-secondary">{t(REPORT_TYPE_LABELS[template.report_type])}</TableCell>
                <TableCell>
                  <input
                    type="checkbox"
                    checked={template.is_default}
                    onChange={(event) => void handleToggleDefault(template.id, event.target.checked)}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => void handleDelete(template.id)}>
                    {t("research.common.delete")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {templates.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-tertiary">
                  {t("research.templates.empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ResearchTableSurface>
    </ResearchListSurface>
  );
});
