/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useCallback, useEffect, useMemo } from "react";
import { useParams } from "next/navigation";
import { observer } from "mobx-react";
// plane imports
import { useTranslation } from "@plane/i18n";
import { setPromiseToast } from "@plane/propel/toast";
// components
import { MemberDropdown } from "@/components/dropdowns/member/dropdown";
import { SettingsControlItem } from "@/components/settings/control-item";
// hooks
import { useMember } from "@/hooks/store/use-member";
import { useUser, useUserProfile } from "@/hooks/store/user";

const MAX_PREFERRED_COLLABORATORS = 3;
export const ProfileSettingsPreferredCollaborators = observer(function ProfileSettingsPreferredCollaborators() {
  // translation
  const { t } = useTranslation();
  // store hooks
  const { data: currentUser, userSettings } = useUser();
  const { data: userProfile, updateUserProfile } = useUserProfile();
  const {
    workspace: { fetchWorkspaceMembers, getWorkspaceMemberIds },
  } = useMember();
  // router params
  const { workspaceSlug } = useParams();
  // 账户设置页不带工作区路由参数时，回退到最近打开或兜底工作区。
  const profileWorkspaceSlug = (
    workspaceSlug?.toString() ||
    userSettings.data.workspace.last_workspace_slug ||
    userSettings.data.workspace.fallback_workspace_slug ||
    ""
  ).trim();

  // 账户设置页不依赖工作区成员加载，需要自行拉取候选成员。
  useEffect(() => {
    if (profileWorkspaceSlug && !(getWorkspaceMemberIds(profileWorkspaceSlug)?.length > 0)) {
      void fetchWorkspaceMembers(profileWorkspaceSlug).catch(() => undefined);
    }
  }, [fetchWorkspaceMembers, getWorkspaceMemberIds, profileWorkspaceSlug]);

  // 成员列表按显式工作区 slug 读取，避免账户设置页缺少路由参数时取不到成员。
  const workspaceMemberIds = profileWorkspaceSlug ? getWorkspaceMemberIds(profileWorkspaceSlug) : [];

  const collaborators = useMemo(
    () => (Array.isArray(userProfile?.preferred_collaborators) ? userProfile.preferred_collaborators : []),
    [userProfile?.preferred_collaborators]
  );

  // 候选成员为当前工作空间成员并排除自己；每个槽位再排除其他已选合作者。
  const candidateIds = workspaceMemberIds.filter((memberId) => memberId !== currentUser?.id);

  // 始终渲染三个有序槽位；空槽位显示占位文案，配置为空时界面保持安静。
  const slots = useMemo<{ key: string; memberId: string | null; index: number }[]>(() => {
    const filled = collaborators.slice(0, MAX_PREFERRED_COLLABORATORS);
    return Array.from({ length: MAX_PREFERRED_COLLABORATORS }, (_, index) => ({
      key: `slot-${index + 1}`,
      memberId: filled[index] ?? null,
      index,
    }));
  }, [collaborators]);

  const saveCollaborators = useCallback(
    (next: string[]) => {
      const update = updateUserProfile({ preferred_collaborators: next });
      setPromiseToast(update, {
        loading: t("account_settings.notifications.preferred_collaborators.saving"),
        success: {
          title: t("account_settings.notifications.preferred_collaborators.saved_title"),
          message: () => t("account_settings.notifications.preferred_collaborators.saved_message"),
        },
        error: {
          title: t("account_settings.notifications.preferred_collaborators.error_title"),
          message: () => t("account_settings.notifications.preferred_collaborators.error_message"),
        },
      });
    },
    [t, updateUserProfile]
  );

  const handleSlotChange = useCallback(
    (slot: (typeof slots)[number], memberId: string | null) => {
      const { index } = slot;
      const nextSlots = [...slots];
      nextSlots[index] = { ...slot, memberId };
      const next = nextSlots.map((item) => item.memberId).filter((id): id is string => Boolean(id));
      if (next.join(",") === collaborators.join(",")) return;
      saveCollaborators(next);
    },
    [collaborators, saveCollaborators, slots]
  );

  if (!userProfile) return null;

  return (
    <SettingsControlItem
      title={t("account_settings.notifications.preferred_collaborators.title")}
      description={t("account_settings.notifications.preferred_collaborators.description")}
      control={
        <div className="flex w-full min-w-60 flex-col gap-2">
          {slots.map((slot) => (
            <div key={slot.key} className="flex items-center gap-2">
              <span className="w-3 text-right text-caption-md-regular text-tertiary">{slot.index + 1}</span>
              <MemberDropdown
                allowClear
                value={slot.memberId}
                onChange={(val) => handleSlotChange(slot, val)}
                multiple={false}
                memberIds={candidateIds.filter(
                  (candidateId) =>
                    !collaborators.some(
                      (selectedId, selectedIndex) => selectedIndex !== slot.index && selectedId === candidateId
                    )
                )}
                buttonVariant="border-with-text"
                buttonClassName="!px-3 !py-2 bg-surface-1 w-full justify-between"
                placeholder={t("account_settings.notifications.preferred_collaborators.placeholder")}
              />
            </div>
          ))}
        </div>
      }
    />
  );
});
