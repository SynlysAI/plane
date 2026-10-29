/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { useParams } from "next/navigation";
import { EUserPermissions, EUserPermissionsLevel, LOGIN_MEDIUM_LABELS } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { renderFormattedDate } from "@plane/utils";
import { MemberHeaderColumn } from "@/components/project/member-header-column";
import type { RowData } from "@/components/workspace/settings/member-columns";
import { AccountTypeColumn, NameColumn } from "@/components/workspace/settings/member-columns";
import type { IWorkspaceMemberTag, IWorkspaceMemberTagGroup } from "@plane/types";
import { useMember } from "@/hooks/store/use-member";
import { MemberTagsEditor } from "./member-tags-editor";
import { MemberTagPill } from "./member-tag-pill";
import { useUser, useUserPermissions } from "@/hooks/store/user";
import type { IMemberFilters } from "@/store/member/utils";

function MemberTagsColumn({ tags, groups }: { tags?: IWorkspaceMemberTag[]; groups: IWorkspaceMemberTagGroup[] }) {
  const [expandedGroupIds, setExpandedGroupIds] = useState<string[]>([]);

  if (!tags?.length) return <span className="text-placeholder">—</span>;

  const groupNames = new Map(groups.map((group) => [group.id, group.name]));
  const tagsByGroup = tags.reduce<Map<string, IWorkspaceMemberTag[]>>((result, tag) => {
    const current = result.get(tag.group_id) ?? [];
    current.push(tag);
    result.set(tag.group_id, current);
    return result;
  }, new Map());

  return (
    <div className="flex max-w-80 flex-wrap gap-x-2 gap-y-1">
      {[...tagsByGroup.entries()].map(([groupId, groupedTags]) => {
        const isExpanded = expandedGroupIds.includes(groupId);
        const visibleTags = isExpanded ? groupedTags : groupedTags.slice(0, 3);
        return (
          <div key={groupId} className="flex items-center gap-1">
            <span className="text-11 text-tertiary">{groupNames.get(groupId) ?? "标签"}</span>
            {visibleTags.map((tag) => (
              <MemberTagPill key={tag.id} tag={tag} />
            ))}
            {groupedTags.length > 3 && (
              <button
                type="button"
                className="text-11 text-tertiary hover:text-primary"
                onClick={() =>
                  setExpandedGroupIds((current) =>
                    isExpanded ? current.filter((id) => id !== groupId) : [...current, groupId]
                  )
                }
              >
                {isExpanded ? "收起" : `+${groupedTags.length - 3}`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

type MemberSelection = {
  selectedMemberIds: string[];
  toggleMember: (memberId: string) => void;
};

export const useMemberColumns = (selection?: MemberSelection) => {
  // states
  const [removeMemberModal, setRemoveMemberModal] = useState<RowData | null>(null);
  const [resetPasswordMember, setResetPasswordMember] = useState<RowData | null>(null);

  const { workspaceSlug } = useParams();

  const { data: currentUser } = useUser();
  const { allowPermissions } = useUserPermissions();
  const {
    workspace: {
      filtersStore: { filters, updateFilters },
      workspaceMemberTagGroups,
    },
  } = useMember();
  const { t } = useTranslation();

  // derived values
  const isAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);
  const [tagEditorMember, setTagEditorMember] = useState<RowData | null>(null);

  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const isSuspended = (rowData: RowData) => rowData.is_active === false;

  // handlers
  const handleDisplayFilterUpdate = (filterUpdates: Partial<IMemberFilters>) => {
    updateFilters(filterUpdates);
  };

  const columns = [
    {
      key: "Full name",
      content: t("workspace_settings.settings.members.details.full_name"),
      thClassName: "text-left",
      thRender: () => (
        <MemberHeaderColumn
          property="full_name"
          displayFilters={filters}
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
      key: "Display name",
      content: t("workspace_settings.settings.members.details.display_name"),
      tdRender: (rowData: RowData) => (
        <div
          className={`w-32 min-w-0 truncate ${isSuspended(rowData) ? "text-placeholder" : ""}`}
          title={rowData.member.display_name ?? ""}
        >
          {rowData.member.display_name}
        </div>
      ),
      thRender: () => (
        <MemberHeaderColumn
          property="display_name"
          displayFilters={filters}
          handleDisplayFilterUpdate={handleDisplayFilterUpdate}
        />
      ),
    },

    {
      key: "Email address",
      content: t("workspace_settings.settings.members.details.email_address"),
      tdRender: (rowData: RowData) => (
        <div
          className={`w-48 min-w-0 truncate ${isSuspended(rowData) ? "text-placeholder" : ""}`}
          title={rowData.member.email ?? ""}
        >
          {rowData.member.email}
        </div>
      ),
      thRender: () => (
        <MemberHeaderColumn
          property="email"
          displayFilters={filters}
          handleDisplayFilterUpdate={handleDisplayFilterUpdate}
        />
      ),
    },

    {
      key: "Account type",
      content: t("workspace_settings.settings.members.details.account_type"),
      thRender: () => (
        <MemberHeaderColumn
          property="role"
          displayFilters={filters}
          handleDisplayFilterUpdate={handleDisplayFilterUpdate}
        />
      ),
      tdRender: (rowData: RowData) => <AccountTypeColumn rowData={rowData} workspaceSlug={workspaceSlug} />,
    },

    {
      key: "Tags",
      content: "标签",
      tdRender: (rowData: RowData) => (
        <div className="flex items-center gap-2">
          <MemberTagsColumn tags={rowData.tags} groups={workspaceMemberTagGroups[workspaceSlug] ?? []} />
          {isAdmin && !isSuspended(rowData) && (
            <button
              type="button"
              className="text-11 text-accent-primary opacity-0 transition-opacity group-hover:opacity-100"
              onClick={() => setTagEditorMember(rowData)}
            >
              编辑
            </button>
          )}
        </div>
      ),
    },

    {
      key: "Authentication",
      content: t("workspace_settings.settings.members.details.authentication"),
      tdRender: (rowData: RowData) => {
        if (isSuspended(rowData)) return null;
        const loginMedium = rowData.last_login_medium;
        if (!loginMedium) return null;
        return <div>{LOGIN_MEDIUM_LABELS[loginMedium]}</div>;
      },
    },

    {
      key: "Joining date",
      content: t("workspace_settings.settings.members.details.joining_date"),
      tdRender: (rowData: RowData) =>
        isSuspended(rowData) ? null : <div>{renderFormattedDate(rowData?.member?.joining_date)}</div>,
      thRender: () => (
        <MemberHeaderColumn
          property="joining_date"
          displayFilters={filters}
          handleDisplayFilterUpdate={handleDisplayFilterUpdate}
        />
      ),
    },
  ];
  if (isAdmin && selection) {
    columns.unshift({
      key: "Select member",
      content: "",
      tdRender: (rowData: RowData) => (
        <input
          type="checkbox"
          aria-label={`选择 ${rowData.member.display_name || rowData.member.email || "成员"}`}
          checked={selection.selectedMemberIds.includes(rowData.member.id)}
          onChange={() => selection.toggleMember(rowData.member.id)}
          className="accent-accent-primary size-3.5"
        />
      ),
    });
  }
  if (isAdmin) {
    columns.push({
      key: "Reset password",
      content: "账号恢复",
      tdRender: (rowData: RowData) =>
        !isSuspended(rowData) && rowData.member.id !== currentUser?.id ? (
          <button
            type="button"
            className="text-12 whitespace-nowrap text-accent-primary underline-offset-4 hover:underline"
            onClick={() => setResetPasswordMember(rowData)}
          >
            重置密码
          </button>
        ) : null,
    });
  }
  return {
    columns,
    workspaceSlug,
    removeMemberModal,
    setRemoveMemberModal,
    resetPasswordMember,
    setResetPasswordMember,
    tagEditorMember,
    setTagEditorMember,
    tagEditor: tagEditorMember ? (
      <MemberTagsEditor
        workspaceSlug={workspaceSlug}
        memberId={tagEditorMember.member.id}
        memberName={
          tagEditorMember.member.display_name ||
          `${tagEditorMember.member.first_name ?? ""} ${tagEditorMember.member.last_name ?? ""}`
        }
        groups={workspaceMemberTagGroups[workspaceSlug] ?? []}
        selectedTags={tagEditorMember.tags ?? []}
        onClose={() => setTagEditorMember(null)}
      />
    ) : null,
  };
};
