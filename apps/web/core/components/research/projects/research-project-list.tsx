/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
import { Settings, Trash2 } from "lucide-react";
// plane imports
import { RESEARCH_PROJECT_STATUS_LABELS, RESEARCH_PROJECT_TYPE_LABELS, RESEARCH_PROJECT_TYPES } from "@plane/constants";
import type { TResearchProjectType } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { TResearchProject } from "@/services/research/project.service";
import { AlertModalCore, ListFilterField, ListFilterSelect } from "@plane/ui";
import { ResearchBrowseFilters } from "@/components/research/common/browse-filters";
import {
  researchBrowseRequestParams,
  researchFilterSummary,
  useResearchBrowseQuery,
} from "@/components/research/common/browse-query";
// components
import { getResearchErrorKey } from "@/components/research/common/error-messages";
import {
  ResearchFilterChips,
  ResearchFilterToolbar,
  ResearchListSurface,
  ResearchTableSurface,
} from "@/components/research/common/research-data-surface";
import { ResearchListState } from "@/components/research/common/research-list-state";
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
import { ResearchDeleteButton } from "@/components/research/common/research-delete-button";
import { ResearchProjectDialog } from "@/components/research/projects/research-project-create-dialog";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
  currentUserId: string;
};

/** Personal cultivation and team research projects in the current scope. */
export const ResearchProjectList = observer(function ResearchProjectList({ workspaceSlug, currentUserId }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const query = useResearchBrowseQuery();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [editingProject, setEditingProject] = useState<TResearchProject | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const statusFilter = query.get("workflow_status");
  const setStatusFilter = (value: string) => query.set("workflow_status", value);
  const typeFilter = query.get("research_type");
  const setTypeFilter = (value: string) => query.set("research_type", value);
  const orgFilter = query.get("org_unit");
  const setOrgFilter = (value: string) => query.set("org_unit", value);
  const ownerFilter = query.get("owner");
  const dateFrom = query.get("date_from");
  const dateTo = query.get("date_to");
  const keyword = query.get("q");
  const scope = query.get("scope", "all");
  const mineFilter = query.get("mine");
  const cursor = query.get("cursor");
  const setCursor = (value: string) => query.set("cursor", value);
  const [pendingProjectAction, setPendingProjectAction] = useState<{
    project: TResearchProject;
    action: "archive" | "restore" | "delete";
  } | null>(null);
  const [isUpdatingProject, setIsUpdatingProject] = useState(false);

  const projects = research.getResearchProjects(workspaceSlug);
  const orgUnits = research.getOrgUnits(workspaceSlug);
  const pagination = research.projectPaginationByWorkspace[workspaceSlug];
  const orgUnitName = (unitId: string | null | undefined) => orgUnits.find((unit) => unit.id === unitId)?.name ?? "-";
  const canCreateProject = Boolean(
    currentUserId && (research.identity?.user.org_units.length || research.isResearchAdmin)
  );
  const shouldAutoOpenCreate = query.get("create") === "1";
  useEffect(() => {
    if (!shouldAutoOpenCreate) return;
    if (canCreateProject) setIsCreateDialogOpen(true);
    query.set("create", "");
    // The query helper is stable for this URL state and is intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCreateProject, shouldAutoOpenCreate]);
  const hasActiveFilters = Boolean(
    query.get("q") ||
    query.get("scope") ||
    typeFilter ||
    orgFilter ||
    ownerFilter.trim() ||
    dateFrom ||
    dateTo ||
    statusFilter
  );

  const filterSummary = useMemo(
    () =>
      researchFilterSummary([
        typeFilter && t(RESEARCH_PROJECT_TYPE_LABELS[typeFilter as TResearchProjectType]),
        orgFilter && orgUnits.find((unit) => unit.id === orgFilter)?.name,
        ownerFilter.trim(),
        dateFrom && `${t("research.common.date_from")}: ${dateFrom}`,
        dateTo && `${t("research.common.date_to")}: ${dateTo}`,
        statusFilter && t(RESEARCH_PROJECT_STATUS_LABELS[statusFilter as keyof typeof RESEARCH_PROJECT_STATUS_LABELS]),
      ]),
    [dateFrom, dateTo, orgFilter, orgUnits, ownerFilter, statusFilter, t, typeFilter]
  );

  const load = useCallback(async () => {
    const params = researchBrowseRequestParams(
      {
        org_unit: orgFilter,
        owner: ownerFilter,
        date_from: dateFrom,
        date_to: dateTo,
        q: keyword,
        scope,
        mine: mineFilter,
        cursor,
      },
      {
        workflow_status: statusFilter,
        research_type: typeFilter,
      }
    );
    try {
      await research.fetchResearchProjects(workspaceSlug, params);
      setErrorKey(null);
    } catch (error) {
      setErrorKey(getResearchErrorKey(error));
    }
  }, [
    cursor,
    dateFrom,
    dateTo,
    orgFilter,
    ownerFilter,
    research,
    statusFilter,
    typeFilter,
    workspaceSlug,
    keyword,
    mineFilter,
    scope,
  ]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workspaceSlug,
    statusFilter,
    typeFilter,
    orgFilter,
    ownerFilter,
    dateFrom,
    dateTo,
    cursor,
    keyword,
    mineFilter,
    scope,
  ]);

  useEffect(() => {
    void research.fetchOrgUnits(workspaceSlug).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug]);

  const handleProjectAction = useCallback(async () => {
    if (!pendingProjectAction || isUpdatingProject) return;
    setIsUpdatingProject(true);
    try {
      if (pendingProjectAction.action === "archive") {
        await research.archiveResearchProject(workspaceSlug, pendingProjectAction.project.id);
      } else if (pendingProjectAction.action === "delete") {
        await research.deleteResearchProject(workspaceSlug, pendingProjectAction.project.id);
      } else {
        await research.restoreResearchProject(workspaceSlug, pendingProjectAction.project.id);
      }
      await load();
      setErrorKey(null);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t(`research.feedback.project_${pendingProjectAction.action}d.title`),
        message: t(`research.feedback.project_${pendingProjectAction.action}d.message`),
      });
      setPendingProjectAction(null);
    } catch (error) {
      setErrorKey(getResearchErrorKey(error));
    } finally {
      setIsUpdatingProject(false);
    }
  }, [isUpdatingProject, load, pendingProjectAction, research, t, workspaceSlug]);

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
      <ResearchProjectDialog
        workspaceSlug={workspaceSlug}
        currentUserId={currentUserId}
        isOpen={isCreateDialogOpen || Boolean(editingProject)}
        project={editingProject}
        onClose={() => {
          setIsCreateDialogOpen(false);
          setEditingProject(null);
        }}
        onUpdated={async () => {
          await load();
        }}
      />
      {errorKey && (
        <div className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
          {t(errorKey)}
        </div>
      )}

      <ResearchFilterToolbar>
        <ListFilterField label={t("research.projects.fields.type")}>
          <ListFilterSelect
            aria-label={t("research.projects.fields.type")}
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
          >
            <option value="">{t("research.projects.all_types")}</option>
            {RESEARCH_PROJECT_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(RESEARCH_PROJECT_TYPE_LABELS[type])}
              </option>
            ))}
          </ListFilterSelect>
        </ListFilterField>
        <ListFilterField label={t("research.projects.fields.org_unit")}>
          <ListFilterSelect
            aria-label={t("research.projects.fields.org_unit")}
            value={orgFilter}
            onChange={(event) => setOrgFilter(event.target.value)}
          >
            <option value="">{t("research.projects.all_org_units")}</option>
            {orgUnits.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
          </ListFilterSelect>
        </ListFilterField>
        <ResearchBrowseFilters workspaceSlug={workspaceSlug} query={query} kind="projects" />
        <ListFilterField label="状态">
          <ListFilterSelect value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="">{t("research.projects.current_projects")}</option>
            {(["ACTIVE", "COMPLETED", "ARCHIVED", "DELETED"] as const).map((status) => (
              <option key={status} value={status}>
                {t(RESEARCH_PROJECT_STATUS_LABELS[status])}
              </option>
            ))}
          </ListFilterSelect>
        </ListFilterField>
      </ResearchFilterToolbar>

      {hasActiveFilters && (
        <ResearchFilterChips
          filters={filterSummary}
          activeLabel={t("research.list_state.active_filters")}
          clearLabel={t("research.list_state.clear_filters")}
          onClear={clearFilters}
        />
      )}

      {research.projectLoader && projects.length === 0 ? (
        <ResearchListState kind="loading" resource="projects" />
      ) : errorKey && projects.length === 0 ? (
        <ResearchListState kind="error" resource="projects" onRetry={() => void load()} />
      ) : projects.length === 0 ? (
        <ResearchListState
          kind={hasActiveFilters ? "no-results" : "empty"}
          resource="projects"
          onClearFilters={clearFilters}
        />
      ) : (
        <ResearchTableSurface>
          <Table className="min-w-[840px]">
            <TableHeader>
              <TableRow>
                <TableHead>{t("research.projects.columns.name")}</TableHead>
                <TableHead>{t("research.projects.columns.owner")}</TableHead>
                <TableHead>{t("research.projects.columns.type")}</TableHead>
                <TableHead>{t("research.projects.columns.org_unit")}</TableHead>
                <TableHead>{t("research.projects.columns.status")}</TableHead>
                <TableHead>{t("research.projects.columns.started_at")}</TableHead>
                <TableHead className="text-right">{t("research.approvals.columns.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((project) => (
                <TableRow key={project.id} className="hover:bg-surface-2">
                  <TableCell className="font-medium text-primary">{project.name}</TableCell>
                  <TableCell className="text-secondary">
                    {project.research?.owner_detail?.display_name ||
                      project.research?.owner_detail?.email ||
                      project.research?.owner ||
                      "-"}
                  </TableCell>
                  <TableCell className="text-tertiary">
                    {project.research
                      ? t(RESEARCH_PROJECT_TYPE_LABELS[project.research.research_type as TResearchProjectType])
                      : "-"}
                  </TableCell>
                  <TableCell className="text-tertiary">{orgUnitName(project.research?.org_unit)}</TableCell>
                  <TableCell>
                    <ResearchStatusBadge status={project.research?.workflow_status ?? "unknown"} size="sm">
                      {project.research
                        ? t(
                            RESEARCH_PROJECT_STATUS_LABELS[
                              project.research.workflow_status as keyof typeof RESEARCH_PROJECT_STATUS_LABELS
                            ]
                          )
                        : "-"}
                    </ResearchStatusBadge>
                  </TableCell>
                  <TableCell className="text-tertiary tabular-nums">{project.research?.started_at ?? "-"}</TableCell>
                  <TableCell className="text-right">
                    {(project.research?.owner === currentUserId || research.isResearchAdmin) && (
                      <ResearchDeleteButton
                        name={project.name}
                        onDelete={async () => {
                          await research.deleteResearchProject(workspaceSlug, project.id);
                          await load();
                        }}
                      />
                    )}
                    {project.research?.research_type === "RESEARCH_PROJECT" ? (
                      <Link
                        className="mr-2 text-12 text-accent-primary hover:underline"
                        href={`/${workspaceSlug}/research/projects/${project.id}/overview`}
                      >
                        {t("research.projects.open_team_project")}
                      </Link>
                    ) : (
                      <Link
                        className="mr-2 text-12 text-accent-primary hover:underline"
                        href={`/${workspaceSlug}/research/projects/${project.id}/stages`}
                      >
                        {t("research.nav.stages")}
                      </Link>
                    )}
                    {(project.research?.owner === currentUserId || research.isResearchAdmin) &&
                      project.research?.workflow_status !== "DELETED" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isUpdatingProject}
                          title={t("research.projects.edit")}
                          aria-label={`${t("research.projects.edit")}：${project.name}`}
                          onClick={() => setEditingProject(project)}
                        >
                          <Settings className="size-4" />
                        </Button>
                      )}
                    {(project.research?.owner === currentUserId || research.isResearchAdmin) &&
                      (!["ARCHIVED", "DELETED"].includes(project.research?.workflow_status ?? "") ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isUpdatingProject}
                          onClick={() => setPendingProjectAction({ project, action: "archive" })}
                        >
                          {t("research.projects.archive")}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isUpdatingProject}
                          onClick={() => setPendingProjectAction({ project, action: "restore" })}
                        >
                          {t("research.projects.restore")}
                        </Button>
                      ))}
                    {(project.research?.owner === currentUserId || research.isResearchAdmin) &&
                      project.research?.workflow_status !== "DELETED" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={isUpdatingProject}
                          title={t("research.projects.delete")}
                          aria-label={`${t("research.projects.delete")}：${project.name}`}
                          onClick={() => setPendingProjectAction({ project, action: "delete" })}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ResearchTableSurface>
      )}
      <div className="flex items-center justify-between gap-2 text-12 text-tertiary">
        <span>{t("research.common.total_results", { count: pagination?.total_results ?? projects.length })}</span>
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

      <AlertModalCore
        isOpen={Boolean(pendingProjectAction)}
        handleClose={() => {
          if (!isUpdatingProject) setPendingProjectAction(null);
        }}
        handleSubmit={() => void handleProjectAction()}
        isSubmitting={isUpdatingProject}
        title={t(`research.projects.confirm_${pendingProjectAction?.action ?? "archive"}_title`)}
        content={
          <>
            <span>
              {t(`research.projects.confirm_${pendingProjectAction?.action ?? "archive"}`, {
                project: pendingProjectAction?.project.name ?? "",
              })}
            </span>
            {errorKey && (
              <span role="alert" className="mt-2 block text-danger-primary">
                {t(errorKey)}
              </span>
            )}
          </>
        }
        primaryButtonText={{
          default: t(`research.projects.${pendingProjectAction?.action ?? "archive"}`),
          loading: t("research.common.loading"),
        }}
        secondaryButtonText={t("research.common.cancel")}
        variant={pendingProjectAction?.action === "restore" ? "primary" : "danger"}
      />
    </ResearchListSurface>
  );
});
