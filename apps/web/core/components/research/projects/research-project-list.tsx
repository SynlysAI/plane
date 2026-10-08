/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { observer } from "mobx-react";
import Link from "next/link";
// plane imports
import { RESEARCH_PROJECT_STATUS_LABELS, RESEARCH_PROJECT_TYPE_LABELS, RESEARCH_PROJECT_TYPES } from "@plane/constants";
import type { TResearchProjectType } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@plane/propel/table";
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { TResearchProject } from "@/services/research/project.service";
import { AlertModalCore, EModalPosition, EModalWidth, Input, ModalCore } from "@plane/ui";
import { ResearchBrowseFilters } from "@/components/research/common/browse-filters";
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
import { ResearchStatusBadge } from "@/components/research/common/research-status-badge";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
  currentUserId: string;
};

type ProjectListQueryFilters = {
  view: string | null;
  workflowStatus: string;
  researchType: string;
  orgUnit: string;
  owner: string;
  dateFrom: string;
  dateTo: string;
};

const PROJECT_LIST_CONTROLLED_QUERY_KEYS = [
  "view",
  "workflow_status",
  "research_type",
  "org_unit",
  "owner",
  "date_from",
  "date_to",
  "cursor",
] as const;

/** Build project-list query parameters while preserving unrelated legacy query values.
 *
 * Args:
 *   current: Query parameters currently present in the browser URL.
 *   filters: Project-list filter values controlled by this component.
 *
 * Returns:
 *   Query parameters containing the controlled filters and all unrelated values.
 */
export function buildProjectListSearchParams(current: URLSearchParams, filters: ProjectListQueryFilters) {
  const params = new URLSearchParams(current);
  PROJECT_LIST_CONTROLLED_QUERY_KEYS.forEach((key) => params.delete(key));
  if (filters.view) params.set("view", filters.view);
  if (filters.workflowStatus) params.set("workflow_status", filters.workflowStatus);
  if (filters.researchType) params.set("research_type", filters.researchType);
  if (filters.orgUnit) params.set("org_unit", filters.orgUnit);
  if (filters.owner.trim()) params.set("owner", filters.owner.trim());
  if (filters.dateFrom) params.set("date_from", filters.dateFrom);
  if (filters.dateTo) params.set("date_to", filters.dateTo);
  return params;
}

/** Personal cultivation and team research projects in the current scope. */
export const ResearchProjectList = observer(function ResearchProjectList({ workspaceSlug, currentUserId }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const query = useResearchBrowseQuery();
  const [name, setName] = useState("");
  const [researchType, setResearchType] = useState<TResearchProjectType>("RESEARCH_PROJECT");
  const [chainKind, setChainKind] = useState<"LEGACY_TRAINING" | "RESEARCH_CHAIN">("RESEARCH_CHAIN");
  const [chainVisibility, setChainVisibility] = useState<"PRIVATE" | "MEMBERS" | "ORG" | "WORKSPACE">("PRIVATE");
  const [orgUnit, setOrgUnit] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
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
  const cursor = query.get("cursor");
  const setCursor = (value: string) => query.set("cursor", value);
  const [pendingProjectAction, setPendingProjectAction] = useState<{
    project: TResearchProject;
    action: "archive" | "restore";
  } | null>(null);
  const [isUpdatingProject, setIsUpdatingProject] = useState(false);
  const researchChainEnabled = Boolean(research.identity?.sections?.research_chain);

  const projects = research.getResearchProjects(workspaceSlug);
  const orgUnits = research.getOrgUnits(workspaceSlug);
  const pagination = research.projectPaginationByWorkspace[workspaceSlug];
  const orgUnitName = (unitId: string | null | undefined) => orgUnits.find((unit) => unit.id === unitId)?.name ?? "-";
  const memberOrgUnitIds = useMemo(
    () => new Set(research.identity?.user.org_units.map((membership) => membership.org_unit) ?? []),
    [research.identity]
  );
  const availableOrgUnits = useMemo(
    () =>
      research.identity?.user.is_workspace_admin ? orgUnits : orgUnits.filter((unit) => memberOrgUnitIds.has(unit.id)),
    [memberOrgUnitIds, orgUnits, research.identity?.user.is_workspace_admin]
  );
  const primaryOrgUnit = useMemo(
    () => research.identity?.user.org_units.find((membership) => membership.is_primary)?.org_unit ?? "",
    [research.identity]
  );
  const canCreateProject = Boolean(
    currentUserId && (research.identity?.user.org_units.length || research.isWorkspaceAdmin)
  );
  const isTeamProject = researchType === "RESEARCH_PROJECT";
  const requiresOrgUnit = !isTeamProject || !research.isWorkspaceAdmin;
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
      [
        typeFilter && t(RESEARCH_PROJECT_TYPE_LABELS[typeFilter as TResearchProjectType]),
        orgFilter && orgUnits.find((unit) => unit.id === orgFilter)?.name,
        ownerFilter.trim(),
        dateFrom && `${t("research.common.date_from")}: ${dateFrom}`,
        dateTo && `${t("research.common.date_to")}: ${dateTo}`,
        statusFilter && t(RESEARCH_PROJECT_STATUS_LABELS[statusFilter as keyof typeof RESEARCH_PROJECT_STATUS_LABELS]),
      ].filter((filter): filter is string => typeof filter === "string" && filter.length > 0),
    [dateFrom, dateTo, orgFilter, orgUnits, ownerFilter, statusFilter, t, typeFilter]
  );

  const load = useCallback(async () => {
    const params: Record<string, string> = { per_page: "50" };
    if (statusFilter) params.workflow_status = statusFilter;
    if (typeFilter) params.research_type = typeFilter;
    if (orgFilter) params.org_unit = orgFilter;
    if (ownerFilter) params.owner = ownerFilter.trim();
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo;
    if (cursor) params.cursor = cursor;
    if (keyword) params.q = keyword;
    params.scope = scope;
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
    scope,
  ]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, statusFilter, typeFilter, orgFilter, ownerFilter, dateFrom, dateTo, cursor, keyword, scope]);

  useEffect(() => {
    void research.fetchOrgUnits(workspaceSlug).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug]);

  useEffect(() => {
    if (!orgUnit && primaryOrgUnit) setOrgUnit(primaryOrgUnit);
  }, [orgUnit, primaryOrgUnit]);

  const handleCreate = useCallback(async () => {
    if (!name.trim() || (requiresOrgUnit && !orgUnit)) return;
    setIsCreating(true);
    try {
      const project = await research.createResearchProject(workspaceSlug, {
        name: name.trim(),
        owner: currentUserId,
        research_type: researchType,
        org_unit: orgUnit || null,
        chain_kind: chainKind,
        ...(chainKind === "RESEARCH_CHAIN" ? { chain_visibility: chainVisibility } : {}),
      });
      setName("");
      setIsCreateDialogOpen(false);
      setErrorKey(null);
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: t("research.feedback.project_created.title"),
        message: t("research.feedback.project_created.message"),
      });
      window.location.assign(
        chainKind === "RESEARCH_CHAIN" && project.research?.chain_id
          ? `/${workspaceSlug}/research/chains/${project.research.chain_id}`
          : researchType === "RESEARCH_PROJECT"
            ? `/${workspaceSlug}/projects/${project.id}/issues`
            : `/${workspaceSlug}/research/projects/${project.id}/stages`
      );
    } catch (error) {
      setErrorKey(getResearchErrorKey(error));
    } finally {
      setIsCreating(false);
    }
  }, [
    chainKind,
    chainVisibility,
    currentUserId,
    name,
    orgUnit,
    requiresOrgUnit,
    research,
    researchType,
    t,
    workspaceSlug,
  ]);

  const handleProjectAction = useCallback(async () => {
    if (!pendingProjectAction || isUpdatingProject) return;
    setIsUpdatingProject(true);
    try {
      if (pendingProjectAction.action === "archive") {
        await research.archiveResearchProject(workspaceSlug, pendingProjectAction.project.id);
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
      {errorKey && (
        <div className="rounded-md border border-danger-strong/40 bg-danger-subtle px-3 py-2 text-12 text-danger-primary">
          {t(errorKey)}
        </div>
      )}

      {canCreateProject && (
        <div className="flex justify-end">
          <Button variant="primary" size="sm" onClick={() => setIsCreateDialogOpen(true)}>
            {t("research.projects.create")}
          </Button>
        </div>
      )}

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
            <h2 className="text-16 font-semibold text-primary">{t("research.projects.create_title")}</h2>
            <p className="mt-1 text-12 text-tertiary">{t("research.projects.create_hint")}</p>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="flex flex-col gap-1 text-12 text-secondary">
              <span>{t("research.projects.fields.name")}</span>
              <Input
                placeholder={t("research.projects.name_placeholder")}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-12 text-secondary">
              <span>{t("research.projects.fields.type")}</span>
              <select
                className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
                value={researchType}
                onChange={(event) => setResearchType(event.target.value as TResearchProjectType)}
              >
                <optgroup label={t("research.projects.type_groups.cultivation")}>
                  {RESEARCH_PROJECT_TYPES.filter((type) => type !== "RESEARCH_PROJECT").map((type) => (
                    <option key={type} value={type}>
                      {t(RESEARCH_PROJECT_TYPE_LABELS[type])}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={t("research.projects.type_groups.team")}>
                  <option value="RESEARCH_PROJECT">{t(RESEARCH_PROJECT_TYPE_LABELS.RESEARCH_PROJECT)}</option>
                </optgroup>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-12 text-secondary">
              <span>{t("research.projects.fields.org_unit")}</span>
              <select
                className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
                value={orgUnit}
                onChange={(event) => setOrgUnit(event.target.value)}
              >
                <option value="">{t("research.projects.org_unit_placeholder")}</option>
                {availableOrgUnits.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name}
                  </option>
                ))}
              </select>
            </label>
            {researchChainEnabled && researchType !== "RESEARCH_PROJECT" && (
              <label className="flex flex-col gap-1 text-12 text-secondary">
                <span>{t("research.projects.fields.chain_kind")}</span>
                <select
                  className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
                  value={chainKind}
                  onChange={(event) => setChainKind(event.target.value as "LEGACY_TRAINING" | "RESEARCH_CHAIN")}
                >
                  <option value="LEGACY_TRAINING">{t("research.projects.chain_kinds.legacy_training")}</option>
                  <option value="RESEARCH_CHAIN">{t("research.projects.chain_kinds.research_chain")}</option>
                </select>
              </label>
            )}
            {researchChainEnabled && chainKind === "RESEARCH_CHAIN" && (
              <label className="flex flex-col gap-1 text-12 text-secondary">
                <span>{t("research.projects.fields.chain_visibility")}</span>
                <select
                  className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
                  value={chainVisibility}
                  onChange={(event) =>
                    setChainVisibility(event.target.value as "PRIVATE" | "MEMBERS" | "ORG" | "WORKSPACE")
                  }
                >
                  {(["PRIVATE", "MEMBERS", "ORG", "WORKSPACE"] as const).map((visibility) => (
                    <option key={visibility} value={visibility}>
                      {t(`research.projects.chain_visibility.${visibility.toLowerCase()}`)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {!primaryOrgUnit && requiresOrgUnit && (
            <p className="mt-2 text-11 text-warning-primary">{t("research.projects.missing_primary_org")}</p>
          )}
          {!orgUnit && isTeamProject && research.isWorkspaceAdmin && (
            <p className="mt-2 text-11 text-tertiary">{t("research.projects.team_org_optional")}</p>
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
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={isCreating}
              disabled={!name.trim() || (requiresOrgUnit && !orgUnit) || !currentUserId}
            >
              {t("research.projects.create")}
            </Button>
          </div>
        </form>
      </ModalCore>

      <ResearchFilterToolbar>
        <select
          aria-label={t("research.projects.fields.type")}
          className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value)}
        >
          <option value="">{t("research.projects.all_types")}</option>
          {RESEARCH_PROJECT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(RESEARCH_PROJECT_TYPE_LABELS[type])}
            </option>
          ))}
        </select>
        <select
          aria-label={t("research.projects.fields.org_unit")}
          className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
          value={orgFilter}
          onChange={(event) => setOrgFilter(event.target.value)}
        >
          <option value="">{t("research.projects.all_org_units")}</option>
          {orgUnits.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.name}
            </option>
          ))}
        </select>
        <ResearchBrowseFilters workspaceSlug={workspaceSlug} query={query} kind="projects" />
        <select
          className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="">{t("research.projects.all_statuses")}</option>
          {(["ACTIVE", "ARCHIVED", "COMPLETED"] as const).map((status) => (
            <option key={status} value={status}>
              {t(RESEARCH_PROJECT_STATUS_LABELS[status])}
            </option>
          ))}
        </select>
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
                    {project.research?.research_type === "RESEARCH_PROJECT" ? (
                      <Link
                        className="mr-2 text-12 text-accent-primary hover:underline"
                        href={`/${workspaceSlug}/projects/${project.id}/issues`}
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
                    {project.research?.owner === currentUserId &&
                      (project.research?.workflow_status === "ACTIVE" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingProjectAction({ project, action: "archive" })}
                        >
                          {t("research.projects.archive")}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingProjectAction({ project, action: "restore" })}
                        >
                          {t("research.projects.restore")}
                        </Button>
                      ))}
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
        content={t(`research.projects.confirm_${pendingProjectAction?.action ?? "archive"}`, {
          project: pendingProjectAction?.project.name ?? "",
        })}
        primaryButtonText={{
          default: t(`research.projects.${pendingProjectAction?.action ?? "archive"}`),
          loading: t("research.common.loading"),
        }}
        secondaryButtonText={t("research.common.cancel")}
        variant={pendingProjectAction?.action === "archive" ? "danger" : "primary"}
      />
    </ResearchListSurface>
  );
});
