/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
import { useNavigate, useParams } from "react-router";
// plane imports
import { REPORT_STATUS_LABELS, REPORT_TYPE_LABELS, REPORT_TYPES } from "@plane/constants";
import type { TReportStatus, TReportType } from "@plane/constants";
import type { TReportTemplate } from "@plane/types";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EModalPosition, EModalWidth, Input, ModalCore } from "@plane/ui";
import { ResearchBrowseFilters } from "@/components/research/common/browse-filters";
import { WorkspaceOutcomes } from "@/components/research/outcomes/workspace-outcomes";
import { useResearchBrowseQuery } from "@/components/research/common/browse-query";
// components
import { getResearchErrorKey } from "@/components/research/common/error-messages";
import {
  ResearchFilterChips,
  ResearchFilterToolbar,
  ResearchListSurface,
  ResearchTableSurface,
} from "@/components/research/common/research-data-surface";
import { ResearchListState } from "@/components/research/common/research-list-state";
import { ResearchTopicMaterialActions } from "@/components/research/materials/topic-material-actions";
// components
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
// hooks
import { useResearch } from "@/hooks/store/use-research";
import { formatResearchDate } from "@/components/research/common/research-format";

type Props = {
  workspaceSlug: string;
  /** `review` turns the list into an approval queue without creation controls. */
  variant?: "default" | "review";
};

/** Report list with period / status / type / owner filters (P0-UI-02). */
const ReportListContent = observer(function ReportListContent({ workspaceSlug, variant = "default" }: Props) {
  const { t, currentLocale } = useTranslation();
  const research = useResearch();
  const query = useResearchBrowseQuery();
  const { reportId } = useParams();
  const navigate = useNavigate();
  const [reportType, setReportType] = useState<TReportType>("WEEKLY");
  const [periodKey, setPeriodKey] = useState("");
  const statusFilter = query.get("status", variant === "review" ? "SUBMITTED" : "");
  const setStatusFilter = (value: string) => query.set("status", value);
  const typeFilter = query.get("report_type");
  const setTypeFilter = (value: string) => query.set("report_type", value);
  const periodFilter = query.get("period_key");
  const setPeriodFilter = (value: string) => query.set("period_key", value);
  const mineOnly = query.get("scope") === "mine" || query.get("mine") === "true";
  const orgFilter = query.get("org_unit");
  const setOrgFilter = (value: string) => query.set("org_unit", value);
  const ownerFilter = query.get("owner");
  const dateFrom = query.get("date_from");
  const dateTo = query.get("date_to");
  const keyword = query.get("q");
  const scope = query.get("scope", "all");
  const cursor = query.get("cursor");
  const setCursor = (value: string) => query.set("cursor", value);
  const [selectedTeamProjects, setSelectedTeamProjects] = useState<string[]>([]);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [templateId, setTemplateId] = useState("");

  const reports = research.getReports(workspaceSlug);
  const orgUnits = research.getOrgUnits(workspaceSlug);
  const pagination = research.reportPaginationByWorkspace[workspaceSlug];
  const canCreateReport = Boolean(research.identity?.user.org_units.length);
  const teamProjects = research
    .getResearchProjects(workspaceSlug)
    .filter((project) => project.research?.research_type === "RESEARCH_PROJECT");
  const templates = research
    .getReportTemplates(workspaceSlug)
    .filter((template: TReportTemplate) => template.report_type === reportType && template.is_active);
  const hasActiveFilters = Boolean(
    statusFilter ||
    typeFilter ||
    periodFilter.trim() ||
    mineOnly ||
    query.get("q") ||
    query.get("scope") ||
    orgFilter ||
    ownerFilter.trim() ||
    dateFrom ||
    dateTo
  );
  const filterSummary = useMemo(
    () =>
      [
        statusFilter && t(REPORT_STATUS_LABELS[statusFilter as TReportStatus]),
        typeFilter && t(REPORT_TYPE_LABELS[typeFilter as TReportType]),
        periodFilter.trim(),
        orgFilter && orgUnits.find((unit) => unit.id === orgFilter)?.name,
        ownerFilter.trim(),
        dateFrom && `${t("research.common.date_from")}: ${dateFrom}`,
        dateTo && `${t("research.common.date_to")}: ${dateTo}`,
        mineOnly && t("research.reports.mine_only"),
      ].filter((filter): filter is string => typeof filter === "string" && filter.length > 0),
    [dateFrom, dateTo, mineOnly, orgFilter, orgUnits, ownerFilter, periodFilter, statusFilter, t, typeFilter]
  );

  const load = useCallback(async () => {
    const params: Record<string, string> = { per_page: "50" };
    if (statusFilter) params.status = statusFilter;
    if (typeFilter) params.report_type = typeFilter;
    if (periodFilter) params.period_key = periodFilter.trim();
    if (mineOnly) params.mine = "true";
    if (orgFilter) params.org_unit = orgFilter;
    if (ownerFilter) params.owner = ownerFilter.trim();
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo;
    if (cursor) params.cursor = cursor;
    if (keyword) params.q = keyword;
    params.scope = scope;
    try {
      await research.fetchReports(workspaceSlug, params);
      setErrorKey(null);
    } catch (error) {
      setErrorKey(getResearchErrorKey(error));
    }
  }, [
    cursor,
    dateFrom,
    dateTo,
    mineOnly,
    orgFilter,
    ownerFilter,
    periodFilter,
    research,
    statusFilter,
    typeFilter,
    workspaceSlug,
    keyword,
    scope,
  ]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspaceSlug,
    statusFilter,
    typeFilter,
    periodFilter,
    mineOnly,
    orgFilter,
    ownerFilter,
    dateFrom,
    dateTo,
    cursor,
    keyword,
    scope,
  ]);

  useEffect(() => {
    void research.fetchResearchProjects(workspaceSlug, { research_type: "RESEARCH_PROJECT" }).catch(() => undefined);
    void research.fetchOrgUnits(workspaceSlug).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug]);

  useEffect(() => {
    if (!isCreateDialogOpen) return;
    void research.fetchReportTemplates(workspaceSlug, { report_type: reportType }).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCreateDialogOpen, reportType, workspaceSlug]);

  const handleCreate = useCallback(async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      const report = await research.createReport(workspaceSlug, {
        report_type: reportType,
        period_key: periodKey.trim() || undefined,
        team_projects: selectedTeamProjects,
        template: templateId || null,
      });
      setPeriodKey("");
      setSelectedTeamProjects([]);
      setIsCreateDialogOpen(false);
      setErrorKey(null);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("research.feedback.report_created.title"),
        message: t("research.feedback.report_created.message"),
      });
      navigate(`/${workspaceSlug}/research/reports/${report.id}`);
    } catch (error) {
      setErrorKey(getResearchErrorKey(error));
    } finally {
      setIsCreating(false);
    }
  }, [isCreating, navigate, periodKey, reportType, research, selectedTeamProjects, t, templateId, workspaceSlug]);

  const clearFilters = () =>
    query.patch({
      status: "",
      workflow_status: "",
      report_type: "",
      research_type: "",
      period_key: "",
      org_unit: "",
      owner: "",
      date_from: "",
      date_to: "",
      date_preset: "",
      q: "",
      scope: "",
      mine: "",
    });

  return (
    <ResearchListSurface>
      {errorKey && (
        <div className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
          {t(errorKey)}
        </div>
      )}

      <ResearchFilterToolbar>
        {canCreateReport && variant === "default" && (
          <Button variant="primary" size="sm" onClick={() => setIsCreateDialogOpen(true)}>
            {t("research.reports.create")}
          </Button>
        )}

        <select
          className="ml-auto rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="">{t("research.reports.all_statuses")}</option>
          {(["DRAFT", "SUBMITTED", "NEEDS_REVISION", "ACCEPTED"] as const).map((status) => (
            <option key={status} value={status}>
              {t(REPORT_STATUS_LABELS[status])}
            </option>
          ))}
        </select>
        <select
          aria-label={t("research.reports.columns.type")}
          className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
        >
          <option value="">{t("research.reports.all_types")}</option>
          {REPORT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(REPORT_TYPE_LABELS[type])}
            </option>
          ))}
        </select>
        <Input
          aria-label={t("research.reports.columns.period")}
          className="!w-40"
          placeholder={t("research.reports.period_filter_placeholder")}
          value={periodFilter}
          onChange={(event) => setPeriodFilter(event.target.value)}
        />
        <select
          aria-label={t("research.reports.columns.org_unit")}
          className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
          value={orgFilter}
          onChange={(event) => setOrgFilter(event.target.value)}
        >
          <option value="">{t("research.reports.all_org_units")}</option>
          {orgUnits.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
        <ResearchBrowseFilters workspaceSlug={workspaceSlug} query={query} kind="reports" />
      </ResearchFilterToolbar>

      {hasActiveFilters && (
        <ResearchFilterChips
          filters={filterSummary}
          activeLabel={t("research.list_state.active_filters")}
          clearLabel={t("research.list_state.clear_filters")}
          onClear={clearFilters}
        />
      )}

      {variant === "default" && (
        <ResearchTopicMaterialActions
          workspaceSlug={workspaceSlug}
          projects={teamProjects.map((project) => ({ id: project.id, name: project.name }))}
        />
      )}

      {research.reportLoader && reports.length === 0 ? (
        <ResearchListState kind="loading" resource="reports" />
      ) : errorKey && reports.length === 0 ? (
        <ResearchListState kind="error" resource="reports" onRetry={() => void load()} />
      ) : reports.length === 0 ? (
        <ResearchListState
          kind={hasActiveFilters ? "no-results" : "empty"}
          resource="reports"
          onClearFilters={clearFilters}
        />
      ) : (
        <ResearchTableSurface>
          <Table className="min-w-[860px]">
            <TableHeader>
              <TableRow>
                <TableHead>{t("research.reports.columns.period")}</TableHead>
                <TableHead>{t("research.reports.columns.type")}</TableHead>
                <TableHead>{t("research.reports.columns.owner")}</TableHead>
                <TableHead>{t("research.reports.columns.org_unit")}</TableHead>
                <TableHead>{t("research.reports.columns.status")}</TableHead>
                <TableHead>{t("research.reports.columns.visibility")}</TableHead>
                <TableHead className="text-right">{t("research.chains.updated_at")}</TableHead>
                <TableHead className="text-right">{t("research.approvals.columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.map((report) => (
                <TableRow key={report.id} className="hover:bg-surface-2">
                  <TableCell>
                    <Link
                      href={`/${workspaceSlug}/research/reports/${report.id}`}
                      className={`font-medium text-primary hover:text-accent-primary ${reportId === report.id ? "text-accent-primary" : ""}`}
                    >
                      {report.period_key}
                    </Link>
                    {report.is_backfill && (
                      <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-10 text-tertiary">
                        {t("research.reports.backfill")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-secondary">{t(REPORT_TYPE_LABELS[report.report_type])}</TableCell>
                  <TableCell className="text-secondary">
                    {report.owner_detail?.display_name ?? report.owner_detail?.email ?? report.owner}
                  </TableCell>
                  <TableCell className="text-tertiary">{report.org_unit_detail?.name ?? "-"}</TableCell>
                  <TableCell>
                    <ResearchStatusBadge status={report.status} size="sm">
                      {t(REPORT_STATUS_LABELS[report.status])}
                    </ResearchStatusBadge>
                  </TableCell>
                  <TableCell className="text-tertiary">
                    {t(`research.report_visibility.${report.visibility.toLowerCase()}`)}
                  </TableCell>
                  <TableCell className="text-right text-tertiary tabular-nums">
                    {formatResearchDate(report.updated_at, currentLocale)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/${workspaceSlug}/research/reports/${report.id}`}
                      className="text-12 text-accent-primary hover:underline"
                    >
                      {t("research.common.open")}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ResearchTableSurface>
      )}
      <div className="flex items-center justify-between gap-2 text-12 text-tertiary">
        <span>{t("research.common.total_results", { count: pagination?.total_results ?? reports.length })}</span>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!pagination?.prev_page_results}
            onClick={() => setCursor(pagination?.prev_cursor ?? "")}
          >
            {t("research.common.previous")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={!pagination?.next_page_results}
            onClick={() => setCursor(pagination?.next_cursor ?? "")}
          >
            {t("research.common.next")}
          </Button>
        </div>
      </div>

      <ModalCore
        isOpen={isCreateDialogOpen}
        handleClose={() => !isCreating && setIsCreateDialogOpen(false)}
        position={EModalPosition.CENTER}
        width={EModalWidth.LG}
      >
        <form
          className="flex flex-col gap-4 p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void handleCreate();
          }}
        >
          <div>
            <h2 className="text-16 font-semibold text-primary">{t("research.reports.create_title")}</h2>
            <p className="mt-1 text-12 text-tertiary">{t("research.reports.create_hint")}</p>
          </div>
          <label className="flex flex-col gap-1 text-12 text-secondary">
            <span>{t("research.reports.columns.type")}</span>
            <select
              className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
              value={reportType}
              onChange={(event) => {
                setReportType(event.target.value as TReportType);
                setTemplateId("");
              }}
            >
              {REPORT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(REPORT_TYPE_LABELS[type])}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-12 text-secondary">
            <span>{t("research.reports.template")}</span>
            <select
              aria-label={t("research.reports.template")}
              className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
              value={templateId}
              onChange={(event) => setTemplateId(event.target.value)}
            >
              <option value="">{t("research.reports.blank_template")}</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
              {!templates.length && (
                <option value="" disabled>
                  {research.templatesLoader
                    ? t("research.reports.template_loading")
                    : t("research.reports.no_templates")}
                </option>
              )}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-12 text-secondary">
            <span>{t("research.reports.columns.period")}</span>
            <Input
              placeholder={t("research.reports.period_placeholder")}
              value={periodKey}
              onChange={(event) => setPeriodKey(event.target.value)}
            />
          </label>
          {teamProjects.length > 0 && (
            <fieldset className="flex flex-col gap-2 text-12 text-secondary">
              <legend>{t("research.reports.team_projects", { count: selectedTeamProjects.length })}</legend>
              <div className="flex max-h-40 flex-col gap-2 overflow-y-auto rounded-md border border-subtle p-3">
                {teamProjects.map((project) => (
                  <label key={project.id} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedTeamProjects.includes(project.id)}
                      onChange={(event) =>
                        setSelectedTeamProjects((current) =>
                          event.target.checked
                            ? [...current, project.id]
                            : current.filter((projectId) => projectId !== project.id)
                        )
                      }
                    />
                    <span className="truncate">{project.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={isCreating}
              onClick={() => setIsCreateDialogOpen(false)}
            >
              {t("research.common.cancel")}
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={isCreating} disabled={isCreating}>
              {t("research.reports.create")}
            </Button>
          </div>
        </form>
      </ModalCore>
    </ResearchListSurface>
  );
});

/** 保留旧报告与 IA v2 路由，在同一入口切换报告/成果而不新增一级导航。 */
export function ResearchReportList(props: Props) {
  const query = useResearchBrowseQuery();
  if (props.variant === "review") return <ReportListContent {...props} />;
  const outcomeView = query.get("view") === "outcomes";
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div
        role="tablist"
        aria-label="报告与成果"
        className="flex shrink-0 gap-4 border-b border-subtle px-5 pt-3"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          query.patch(
            {
              view: (event.key === "ArrowRight") !== outcomeView ? "reports" : "outcomes",
            },
            false
          );
        }}
      >
        {[
          ["reports", "报告"],
          ["outcomes", "成果"],
        ].map(([value, label]) => (
          <button
            key={value}
            id={`research-report-tab-${value}`}
            role="tab"
            aria-controls="research-report-panel"
            aria-selected={outcomeView === (value === "outcomes")}
            tabIndex={outcomeView === (value === "outcomes") ? 0 : -1}
            className={`border-b-2 px-1 pb-2 text-14 ${outcomeView === (value === "outcomes") ? "border-primary font-semibold text-primary" : "border-transparent text-secondary"}`}
            onClick={() => query.patch({ view: value }, false)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="research-report-panel"
        aria-labelledby={`research-report-tab-${outcomeView ? "outcomes" : "reports"}`}
        tabIndex={-1}
        className="min-h-0 flex-1"
      >
        {outcomeView ? <WorkspaceOutcomes workspaceSlug={props.workspaceSlug} /> : <ReportListContent {...props} />}
      </div>
    </div>
  );
}
