/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
// plane imports
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { GANTT_TIMELINE_TYPE } from "@plane/types";
// components
import { ProjectAccessRestriction } from "@/components/auth-screens/project/project-access-restriction";
import {
  PROJECT_DETAILS,
  PROJECT_ME_INFORMATION,
  PROJECT_LABELS,
  PROJECT_MEMBERS,
  PROJECT_MEMBER_PREFERENCES,
  PROJECT_STATES,
  PROJECT_ESTIMATES,
  PROJECT_ALL_CYCLES,
  PROJECT_MODULES,
  PROJECT_VIEWS,
  PROJECT_INTAKE_STATE,
} from "@plane/constants";
// hooks
import { useProjectEstimates } from "@/hooks/store/estimates";
import { useCycle } from "@/hooks/store/use-cycle";
import { useLabel } from "@/hooks/store/use-label";
import { useMember } from "@/hooks/store/use-member";
import { useModule } from "@/hooks/store/use-module";
import { useProject } from "@/hooks/store/use-project";
import { useProjectState } from "@/hooks/store/use-project-state";
import { useProjectView } from "@/hooks/store/use-project-view";
import { useUser, useUserPermissions } from "@/hooks/store/user";
import { useTimeLineChart } from "@/hooks/use-timeline-chart";

interface IProjectAuthWrapper {
  workspaceSlug: string;
  projectId: string;
  children: ReactNode;
  isLoading?: boolean;
}

export const ProjectAuthWrapper = observer(function ProjectAuthWrapper(props: IProjectAuthWrapper) {
  const { workspaceSlug, projectId, children, isLoading: isParentLoading = false } = props;
  // states
  const [isJoiningProject, setIsJoiningProject] = useState(false);
  // store hooks
  const { fetchUserProjectInfo, allowPermissions, getProjectRoleByWorkspaceSlugAndProjectId } = useUserPermissions();
  const { fetchProjectDetails } = useProject();
  const { joinProject } = useUserPermissions();
  const { fetchAllCycles } = useCycle();
  const { fetchModulesSlim, fetchModules } = useModule();
  const { initGantt } = useTimeLineChart(GANTT_TIMELINE_TYPE.MODULE);
  const { fetchViews } = useProjectView();
  const {
    project: { fetchProjectMembers, fetchProjectUserProperties },
  } = useMember();
  const { fetchProjectStates, fetchProjectIntakeState } = useProjectState();
  const { data: currentUserData } = useUser();
  const { fetchProjectLabels } = useLabel();
  const { getProjectEstimates } = useProjectEstimates();
  // derived values
  const hasPermissionToCurrentProject = allowPermissions(
    [EUserPermissions.ADMIN, EUserPermissions.MEMBER, EUserPermissions.GUEST],
    EUserPermissionsLevel.PROJECT,
    workspaceSlug,
    projectId
  );
  const currentProjectRole = getProjectRoleByWorkspaceSlugAndProjectId(workspaceSlug, projectId);
  const isWorkspaceAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE, workspaceSlug);
  // Initialize module timeline chart
  useEffect(() => {
    initGantt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // fetching project details
  const {
    data: projectDetails,
    isLoading: isProjectDetailsLoading,
    error: projectDetailsError,
    mutate: revalidateProjectDetails,
  } = useSWR(PROJECT_DETAILS(workspaceSlug, projectId), () => fetchProjectDetails(workspaceSlug, projectId));
  const isMembershipRequired = projectDetailsError?.data?.code === "PROJECT_MEMBERSHIP_REQUIRED";
  const canLoadProjectResources = !!projectDetails && hasPermissionToCurrentProject && !projectDetailsError;
  // fetching user project member information
  useSWR(PROJECT_ME_INFORMATION(workspaceSlug, projectId), () => fetchUserProjectInfo(workspaceSlug, projectId));
  // fetching project member preferences
  useSWR(
    canLoadProjectResources && currentUserData?.id ? PROJECT_MEMBER_PREFERENCES(projectId, currentProjectRole) : null,
    () => fetchProjectUserProperties(workspaceSlug, projectId),
    { revalidateIfStale: false, revalidateOnFocus: false }
  );
  // fetching project labels
  useSWR(
    canLoadProjectResources ? PROJECT_LABELS(projectId, currentProjectRole) : null,
    () => fetchProjectLabels(workspaceSlug, projectId),
    {
      revalidateIfStale: false,
      revalidateOnFocus: false,
    }
  );
  // fetching project members
  useSWR(
    canLoadProjectResources ? PROJECT_MEMBERS(projectId, currentProjectRole) : null,
    () => fetchProjectMembers(workspaceSlug, projectId),
    {
      revalidateIfStale: false,
      revalidateOnFocus: false,
    }
  );
  // fetching project states
  useSWR(
    canLoadProjectResources ? PROJECT_STATES(projectId, currentProjectRole) : null,
    () => fetchProjectStates(workspaceSlug, projectId),
    {
      revalidateIfStale: false,
      revalidateOnFocus: false,
    }
  );
  // fetching project intake state
  useSWR(
    canLoadProjectResources ? PROJECT_INTAKE_STATE(projectId, currentProjectRole) : null,
    () => fetchProjectIntakeState(workspaceSlug, projectId),
    {
      revalidateIfStale: false,
      revalidateOnFocus: false,
    }
  );
  // fetching project estimates
  useSWR(
    canLoadProjectResources ? PROJECT_ESTIMATES(projectId, currentProjectRole) : null,
    () => getProjectEstimates(workspaceSlug, projectId),
    {
      revalidateIfStale: false,
      revalidateOnFocus: false,
    }
  );
  // fetching project cycles
  useSWR(
    canLoadProjectResources ? PROJECT_ALL_CYCLES(projectId, currentProjectRole) : null,
    () => fetchAllCycles(workspaceSlug, projectId),
    {
      revalidateIfStale: false,
      revalidateOnFocus: false,
    }
  );
  // fetching project modules
  useSWR(
    canLoadProjectResources ? PROJECT_MODULES(projectId, currentProjectRole) : null,
    async () => {
      await Promise.all([fetchModulesSlim(workspaceSlug, projectId), fetchModules(workspaceSlug, projectId)]);
    },
    { revalidateIfStale: false, revalidateOnFocus: false }
  );
  // fetching project views
  useSWR(
    canLoadProjectResources ? PROJECT_VIEWS(projectId, currentProjectRole) : null,
    () => fetchViews(workspaceSlug, projectId),
    {
      revalidateIfStale: false,
      revalidateOnFocus: false,
    }
  );

  // handle join project
  const handleJoinProject = () => {
    if (isMembershipRequired) return;
    setIsJoiningProject(true);
    joinProject(workspaceSlug, projectId)
      .then(() => revalidateProjectDetails())
      .finally(() => setIsJoiningProject(false));
  };

  const isProjectLoading = (isParentLoading || isProjectDetailsLoading) && !projectDetailsError;

  if (isProjectLoading) return null;

  if (projectDetailsError || hasPermissionToCurrentProject === false) {
    return (
      <ProjectAccessRestriction
        errorStatusCode={projectDetailsError?.status}
        isMembershipRequired={isMembershipRequired}
        isWorkspaceAdmin={isWorkspaceAdmin}
        handleJoinProject={handleJoinProject}
        isJoinButtonDisabled={isJoiningProject}
      />
    );
  }

  return <>{children}</>;
});
