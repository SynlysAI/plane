/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { useTranslation } from "@plane/i18n";
// plane imports
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import type { IWorkspaceMember, TProjectMembership } from "@plane/types";

// components
import { MemberHeaderColumn } from "@/components/project/member-header-column";
import { AccountTypeColumn, NameColumn } from "@/components/project/settings/member-columns";
// hooks
import { useMember } from "@/hooks/store/use-member";
import { useProject } from "@/hooks/store/use-project";
import { useUser, useUserPermissions } from "@/hooks/store/user";
import type { IMemberFilters } from "@/store/member/utils";

export interface RowData extends Pick<
  TProjectMembership,
  "original_role" | "membership_source" | "inherits_organization"
> {
  role?: TProjectMembership["role"];
  member: IWorkspaceMember;
}

type TUseProjectColumnsProps = {
  projectId: string;
  workspaceSlug: string;
};

export const useProjectColumns = (props: TUseProjectColumnsProps) => {
  const { projectId, workspaceSlug } = props;
  const { t, currentLocale } = useTranslation();
  // states
  const [removeMemberModal, setRemoveMemberModal] = useState<RowData | null>(null);

  // store hooks
  const { data: currentUser } = useUser();
  const { getPartialProjectById } = useProject();
  const { allowPermissions, getProjectRoleByWorkspaceSlugAndProjectId } = useUserPermissions();
  const {
    project: {
      filters: { getFilters, updateFilters },
    },
  } = useMember();
  // derived values
  const isAdmin = allowPermissions(
    [EUserPermissions.ADMIN],
    EUserPermissionsLevel.PROJECT,
    workspaceSlug.toString(),
    projectId.toString()
  );
  const currentProjectRole =
    getProjectRoleByWorkspaceSlugAndProjectId(workspaceSlug.toString(), projectId.toString()) ?? EUserPermissions.GUEST;

  const displayFilters = getFilters(projectId);

  // handlers
  const handleDisplayFilterUpdate = (filters: Partial<IMemberFilters>) => {
    updateFilters(projectId, filters);
  };

  const columns = [
    {
      key: "Full Name",
      content: t("project_members.full_name"),
      thClassName: "text-left",
      thRender: () => (
        <MemberHeaderColumn
          property="full_name"
          displayFilters={displayFilters}
          handleDisplayFilterUpdate={handleDisplayFilterUpdate}
        />
      ),
      tdRender: (rowData: RowData) => (
        <NameColumn
          rowData={rowData}
          workspaceSlug={workspaceSlug}
          isAdmin={isAdmin}
          currentUser={currentUser}
          setRemoveMemberModal={setRemoveMemberModal}
        />
      ),
    },
    {
      key: "Display Name",
      content: t("display_name"),
      thRender: () => (
        <MemberHeaderColumn
          property="display_name"
          displayFilters={displayFilters}
          handleDisplayFilterUpdate={handleDisplayFilterUpdate}
        />
      ),
      tdRender: (rowData: RowData) => <div className="w-32">{rowData.member.display_name}</div>,
    },
    {
      key: "Email",
      content: t("email"),
      thRender: () => (
        <MemberHeaderColumn
          property="email"
          displayFilters={displayFilters}
          handleDisplayFilterUpdate={handleDisplayFilterUpdate}
        />
      ),
      tdRender: (rowData: RowData) => <div className="w-48 text-secondary">{rowData.member.email}</div>,
    },
    {
      key: "Account Type",
      content: t("role"),
      thRender: () => (
        <MemberHeaderColumn
          property="role"
          displayFilters={displayFilters}
          handleDisplayFilterUpdate={handleDisplayFilterUpdate}
        />
      ),
      tdRender: (rowData: RowData) => (
        <AccountTypeColumn
          rowData={rowData}
          currentProjectRole={currentProjectRole}
          projectId={projectId}
          workspaceSlug={workspaceSlug}
        />
      ),
    },
    {
      key: "Membership Source",
      content: t("project_settings.members.membership_source"),
      tdRender: (rowData: RowData) => (
        <div className="min-w-24 text-12 text-secondary">
          {rowData.membership_source === "ORGANIZATION"
            ? t("project_settings.members.source_organization")
            : rowData.inherits_organization
              ? t("project_settings.members.source_both")
              : t("project_settings.members.source_direct")}
        </div>
      ),
    },
    {
      key: "Joining Date",
      content: t("project_members.joining_date"),
      thRender: () => (
        <MemberHeaderColumn
          property="joining_date"
          displayFilters={displayFilters}
          handleDisplayFilterUpdate={handleDisplayFilterUpdate}
        />
      ),
      tdRender: (rowData: RowData) => (
        <div>
          {rowData.member.joining_date
            ? new Intl.DateTimeFormat(currentLocale, { year: "numeric", month: "short", day: "numeric" }).format(
                new Date(rowData.member.joining_date)
              )
            : "—"}
        </div>
      ),
    },
  ];
  return {
    columns:
      getPartialProjectById(projectId)?.is_research_project === false
        ? columns
        : columns.filter((column) => column.key !== "Membership Source"),
    removeMemberModal,
    setRemoveMemberModal,
    displayFilters,
    handleDisplayFilterUpdate,
  };
};
