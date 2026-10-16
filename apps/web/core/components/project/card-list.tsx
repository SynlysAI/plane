/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { EUserPermissionsLevel, EUserPermissions } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { EmptyStateDetailed } from "@plane/propel/empty-state";
import { ContentWrapper } from "@plane/ui";
// components
import { calculateTotalFilters } from "@plane/utils";
import { ProjectsLoader } from "@/components/ui/loader/projects-loader";
// hooks
import { useCommandPalette } from "@/hooks/store/use-command-palette";
import { useProject } from "@/hooks/store/use-project";
import { useProjectFilter } from "@/hooks/store/use-project-filter";
import { useUserPermissions } from "@/hooks/store/user";
// local imports
import { ProjectCard } from "./card";
import { groupProjectsByOrganization, type TProjectOrganizationOption } from "./project-org-groups";

type TProjectCardListProps = {
  totalProjectIds?: string[];
  filteredProjectIds?: string[];
  organizations?: TProjectOrganizationOption[];
};

export const ProjectCardList = observer(function ProjectCardList(props: TProjectCardListProps) {
  const { totalProjectIds: totalProjectIdsProps, filteredProjectIds: filteredProjectIdsProps, organizations } = props;
  // plane hooks
  const { t } = useTranslation();
  // store hooks
  const { toggleCreateProjectModal } = useCommandPalette();
  const {
    loader,
    fetchStatus,
    workspaceProjectIds: storeWorkspaceProjectIds,
    filteredProjectIds: storeFilteredProjectIds,
    getProjectById,
  } = useProject();
  const { currentWorkspaceDisplayFilters, currentWorkspaceFilters } = useProjectFilter();
  const { allowPermissions } = useUserPermissions();

  // derived values
  const workspaceProjectIds = totalProjectIdsProps ?? storeWorkspaceProjectIds;
  const filteredProjectIds = filteredProjectIdsProps ?? storeFilteredProjectIds;

  // permissions
  const canPerformEmptyStateActions = allowPermissions(
    [EUserPermissions.ADMIN, EUserPermissions.MEMBER],
    EUserPermissionsLevel.WORKSPACE
  );

  if (!filteredProjectIds || !workspaceProjectIds || loader === "init-loader" || fetchStatus !== "complete")
    return <ProjectsLoader />;

  if (workspaceProjectIds?.length === 0 && !currentWorkspaceDisplayFilters?.archived_projects)
    return (
      <EmptyStateDetailed
        title={t("workspace_projects.empty_state.general.title")}
        description={t("workspace_projects.empty_state.general.description")}
        assetKey="project"
        assetClassName="size-40"
        actions={[
          {
            label: t("workspace_projects.empty_state.general.primary_button.text"),
            onClick: () => {
              toggleCreateProjectModal(true);
            },
            disabled: !canPerformEmptyStateActions,
            variant: "primary",
          },
        ]}
      />
    );

  if (filteredProjectIds.length === 0)
    return (
      <EmptyStateDetailed
        title={
          currentWorkspaceDisplayFilters?.archived_projects &&
          calculateTotalFilters(currentWorkspaceFilters ?? {}) === 0
            ? t("workspace_empty_state.projects_archived.title")
            : t("common_empty_state.search.title")
        }
        description={
          currentWorkspaceDisplayFilters?.archived_projects &&
          calculateTotalFilters(currentWorkspaceFilters ?? {}) === 0
            ? t("workspace_empty_state.projects_archived.description")
            : t("common_empty_state.search.description")
        }
        assetKey={
          currentWorkspaceDisplayFilters?.archived_projects &&
          calculateTotalFilters(currentWorkspaceFilters ?? {}) === 0
            ? "archived-work-item"
            : "search"
        }
        assetClassName="size-40"
      />
    );

  const projectGroups = organizations?.length
    ? groupProjectsByOrganization(filteredProjectIds, getProjectById, organizations)
    : undefined;

  const projectCards = (projectIds: string[]) =>
    projectIds.map((projectId) => {
      const projectDetails = getProjectById(projectId);
      if (!projectDetails) return;
      return <ProjectCard key={projectDetails.id} project={projectDetails} />;
    });

  if (projectGroups) {
    return (
      <ContentWrapper>
        <div className="space-y-10 pb-8">
          {projectGroups.map((group) => (
            <section key={group.id ?? "ungrouped"} aria-label={group.name}>
              <div className="mb-4 flex items-baseline gap-2 border-b border-subtle pb-2">
                <h3 className="text-14 font-medium text-secondary">{group.name}</h3>
                <span className="text-12 text-tertiary">{group.projectIds.length}</span>
              </div>
              <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3">
                {projectCards(group.projectIds)}
              </div>
            </section>
          ))}
        </div>
      </ContentWrapper>
    );
  }

  return (
    <ContentWrapper>
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2 lg:grid-cols-3">{projectCards(filteredProjectIds)}</div>
    </ContentWrapper>
  );
});
