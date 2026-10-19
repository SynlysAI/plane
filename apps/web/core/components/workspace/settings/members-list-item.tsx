/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useState } from "react";
import { isEmpty } from "lodash-es";
import { observer } from "mobx-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { Button } from "@plane/propel/button";
import type { IWorkspaceMember } from "@plane/types";
import { Table } from "@plane/ui";
// components
import { MembersLayoutLoader } from "@/components/ui/loader/layouts/members-layout-loader";
import { ConfirmWorkspaceMemberRemove } from "@/components/workspace/confirm-workspace-member-remove";
import type { RowData } from "@/components/workspace/settings/member-columns";
import { WorkspacePasswordResetModal } from "./password-reset-modal";
import { BulkMemberTagsEditor } from "./bulk-member-tags-editor";
// hooks
import { useMember } from "@/hooks/store/use-member";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { useUser, useUserPermissions, useUserSettings } from "@/hooks/store/user";
import { useAppRouter } from "@/hooks/use-app-router";
// plane web imports
import { useMemberColumns } from "@/components/workspace/settings/useMemberColumns";

type Props = {
  memberDetails: (IWorkspaceMember | null)[];
};

export const WorkspaceMembersListItem = observer(function WorkspaceMembersListItem(props: Props) {
  const { memberDetails } = props;
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [isBulkTagEditorOpen, setIsBulkTagEditorOpen] = useState(false);
  const toggleMember = (memberId: string) => {
    setSelectedMemberIds((current) =>
      current.includes(memberId) ? current.filter((id) => id !== memberId) : [...current, memberId]
    );
  };
  const {
    columns,
    workspaceSlug,
    removeMemberModal,
    setRemoveMemberModal,
    resetPasswordMember,
    setResetPasswordMember,
    tagEditor,
  } = useMemberColumns({ selectedMemberIds, toggleMember });
  // router
  const router = useAppRouter();
  // store hooks
  const { data: currentUser } = useUser();
  const {
    workspace: { removeMemberFromWorkspace, workspaceMemberTagGroups },
  } = useMember();
  const { leaveWorkspace } = useUserPermissions();
  const { getWorkspaceRedirectionUrl } = useWorkspace();
  const { fetchCurrentUserSettings } = useUserSettings();
  const { t } = useTranslation();
  // derived values

  const handleLeaveWorkspace = async () => {
    if (!workspaceSlug || !currentUser) return;

    try {
      await leaveWorkspace(workspaceSlug.toString());
      await fetchCurrentUserSettings();
      router.push(getWorkspaceRedirectionUrl());
    } catch (err: unknown) {
      const error = err as { error?: string };
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Error!",
        message: error?.error || t("something_went_wrong_please_try_again"),
      });
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!workspaceSlug || !memberId) return;

    try {
      await removeMemberFromWorkspace(workspaceSlug.toString(), memberId);
    } catch (err: unknown) {
      const error = err as { error?: string };
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "Error!",
        message: error?.error || t("something_went_wrong_please_try_again"),
      });
    }
  };

  const handleRemove = async (memberId: string) => {
    if (memberId === currentUser?.id) await handleLeaveWorkspace();
    else await handleRemoveMember(memberId);
  };

  // is the member current logged in user
  // const isCurrentUser = memberDetails?.member.id === currentUser?.id;
  // is the current logged in user admin
  // role change access-
  // 1. user cannot change their own role
  // 2. only admin or member can change role
  // 3. user cannot change role of higher role

  if (isEmpty(columns)) return <MembersLayoutLoader />;

  return (
    <div className="grid border-t border-subtle">
      {resetPasswordMember && (
        <WorkspacePasswordResetModal
          key={resetPasswordMember.member.id}
          workspaceSlug={workspaceSlug}
          user={resetPasswordMember.member}
          onClose={() => setResetPasswordMember(null)}
        />
      )}
      {tagEditor}
      {isBulkTagEditorOpen && workspaceSlug && (
        <BulkMemberTagsEditor
          workspaceSlug={workspaceSlug}
          memberIds={selectedMemberIds}
          groups={workspaceMemberTagGroups[workspaceSlug] ?? []}
          onClose={() => setIsBulkTagEditorOpen(false)}
        />
      )}
      {removeMemberModal && (
        <ConfirmWorkspaceMemberRemove
          isOpen={removeMemberModal.member.id.length > 0}
          onClose={() => setRemoveMemberModal(null)}
          userDetails={{
            id: removeMemberModal.member.id,
            display_name: removeMemberModal.member.display_name || "",
          }}
          onSubmit={() => handleRemove(removeMemberModal.member.id)}
        />
      )}
      {selectedMemberIds.length > 0 && (
        <div className="flex items-center justify-between border-b border-subtle bg-surface-2 px-3 py-2">
          <span className="text-12 text-secondary">已选择 {selectedMemberIds.length} 名成员</span>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={() => setSelectedMemberIds([])}>
              取消选择
            </Button>
            <Button variant="primary" size="sm" onClick={() => setIsBulkTagEditorOpen(true)}>
              批量调整标签
            </Button>
          </div>
        </div>
      )}
      <Table<RowData>
        columns={columns ?? []}
        data={
          (memberDetails?.filter((member): member is IWorkspaceMember => member !== null) ?? []) as unknown as RowData[]
        }
        keyExtractor={(rowData) => rowData?.member.id ?? ""}
        tHeadClassName="border-b border-subtle"
        thClassName="text-left font-medium divide-x-0 text-placeholder"
        tBodyClassName="divide-y-0"
        tBodyTrClassName="divide-x-0 p-4 h-10 text-secondary"
        tHeadTrClassName="divide-x-0"
      />
    </div>
  );
});
