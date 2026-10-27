/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import React, { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useForm, Controller, useWatch } from "react-hook-form";
// plane imports
import { Avatar } from "@makeplane/propel/components/avatar";
import { ROLE, ROLE_DETAILS, EUserPermissions } from "@plane/constants";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { ChevronDownOutline, CloseOutline, TickOutline } from "@makeplane/propel/icons";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { CustomSelect, CustomSearchSelect, EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import type { IUser, IUserLite, IWorkspaceMemberTagGroup } from "@plane/types";
// helpers
import { getFileURL } from "@plane/utils";
// hooks
import { useMember } from "@/hooks/store/use-member";
import { useUserPermissions } from "@/hooks/store/user";
import { getMemberTagClassNames } from "@/components/workspace/settings/member-tag-pill";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  projectId: string;
  workspaceSlug: string;
};

type FormValues = {
  memberIds: string[];
  roles: Record<string, EUserPermissions>;
};

const defaultValues: FormValues = {
  memberIds: [],
  roles: {},
};

/** 获取成员全名；中文姓名字段直接拼接，西文字段保留空格。 */
const getMemberFullName = (member: IUserLite) => {
  const names = [member.first_name ?? "", member.last_name ?? ""].map((name) => name.trim()).filter(Boolean);
  if (names.length === 2 && names.every((name) => /[\u4e00-\u9fff]/.test(name))) return names.join("");
  return names.join(" ");
};

/** 并列展示成员全名与显示名称，两者相同时只保留一个。 */
const getMemberDisplayName = (member: IUserLite) => {
  const fullName = getMemberFullName(member);
  const displayName = member.display_name?.trim() ?? "";
  if (fullName && displayName && fullName !== displayName) return `${fullName} · ${displayName}`;
  return fullName || displayName || member.email || member.id;
};

/** 将项目成员添加失败转换为用户可理解的提示。 */
const getAddMemberErrorMessage = (error: unknown, translate: (key: string) => string) => {
  const payload = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const errorCode = "error_code" in payload ? String(payload.error_code) : "";
  const message = "error" in payload ? String(payload.error) : "";
  if (errorCode === "role_lower_than_workspace" || message.includes("role lower than the workspace role")) {
    return translate("project_settings.members.role_lower_than_workspace");
  }
  if (errorCode === "role_higher_than_workspace" || message.includes("role higher than the workspace role")) {
    return translate("project_settings.members.role_higher_than_workspace");
  }
  return translate("project_settings.members.add_failed");
};

export const SendProjectInvitationModal = observer(function SendProjectInvitationModal(props: Props) {
  const { isOpen, onClose, onSuccess, projectId, workspaceSlug } = props;
  // plane hooks
  const { t } = useTranslation();
  // store hooks
  const { getProjectRoleByWorkspaceSlugAndProjectId } = useUserPermissions();
  const {
    project: { getProjectMemberDetails, bulkAddMembersToProject },
    workspace: {
      workspaceMemberIds,
      getWorkspaceMemberDetails,
      fetchWorkspaceMemberTagGroups,
      workspaceMemberTagGroups,
    },
  } = useMember();
  const [tagGroups, setTagGroups] = useState<IWorkspaceMemberTagGroup[]>(
    () => workspaceMemberTagGroups[workspaceSlug] ?? []
  );
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [tagFilterLoading, setTagFilterLoading] = useState(false);
  const [tagFilterError, setTagFilterError] = useState(false);
  // form info
  const {
    formState: { errors, isSubmitting },
    getValues,
    setValue,
    reset,
    handleSubmit,
    control,
  } = useForm<FormValues>({ defaultValues });
  const selectedMemberIds = useWatch({ control, name: "memberIds", defaultValue: [] }) ?? [];
  // derived values
  const currentProjectRole = getProjectRoleByWorkspaceSlugAndProjectId(workspaceSlug, projectId);
  const uninvitedPeople = workspaceMemberIds?.filter((userId) => {
    const projectMemberDetails = getProjectMemberDetails(userId, projectId);
    const isInvited = projectMemberDetails?.member.id && projectMemberDetails?.original_role;
    return !isInvited;
  });
  const candidateTagIds = new Set(
    (uninvitedPeople ?? []).flatMap((userId) => getWorkspaceMemberDetails(userId)?.tags?.map((tag) => tag.id) ?? [])
  );
  const availableTagGroups: IWorkspaceMemberTagGroup[] = [];
  for (const group of tagGroups) {
    const tags = group.tags.filter((tag) => candidateTagIds.has(tag.id));
    if (tags.length > 0) availableTagGroups.push({ ...group, tags });
  }
  const tagFilteredMemberIds = (uninvitedPeople ?? []).filter((userId) => {
    if (selectedTagIds.length === 0) return true;
    const memberTagIds = new Set(getWorkspaceMemberDetails(userId)?.tags?.map((tag) => tag.id) ?? []);
    return selectedTagIds.every((tagId) => memberTagIds.has(tagId));
  });

  useEffect(() => {
    if (!isOpen || !workspaceSlug) return;
    let ignored = false;

    setTagFilterError(false);
    setTagFilterLoading(true);
    fetchWorkspaceMemberTagGroups(workspaceSlug.toString())
      .then((groups) => {
        if (!ignored) setTagGroups(groups);
        return groups;
      })
      .catch((error) => {
        console.error("Failed to load workspace member tag groups", error);
        if (!ignored) setTagFilterError(true);
      })
      .finally(() => {
        if (!ignored) setTagFilterLoading(false);
      });

    return () => {
      ignored = true;
    };
  }, [fetchWorkspaceMemberTagGroups, isOpen, workspaceSlug]);

  const onSubmit = async (formData: FormValues) => {
    if (!workspaceSlug || !projectId || isSubmitting) return;

    const payload = {
      members: formData.memberIds.map((memberId) => ({
        member_id: memberId,
        role: Number(formData.roles[memberId] ?? EUserPermissions.GUEST) as EUserPermissions,
      })),
    };

    try {
      await bulkAddMembersToProject(workspaceSlug.toString(), projectId.toString(), payload);
      onSuccess?.();
      onClose();
      setToast({
        title: t("toast.success"),
        type: TOAST_TYPE.SUCCESS,
        message: t("project_settings.members.added_successfully"),
      });
      reset(defaultValues);
      setSelectedTagIds([]);
    } catch (error) {
      console.error(error);
      setToast({
        title: t("toast.error"),
        type: TOAST_TYPE.ERROR,
        message: getAddMemberErrorMessage(error, t),
      });
    }
  };

  const handleClose = () => {
    onClose();
    setSelectedTagIds([]);

    const timeout = setTimeout(() => {
      reset(defaultValues);
      clearTimeout(timeout);
    }, 500);
  };

  const options = tagFilteredMemberIds
    ?.map((userId) => {
      const memberDetails = getWorkspaceMemberDetails(userId);
      const member = memberDetails?.member;

      if (!member) return;
      const fullName = getMemberFullName(member);
      // IUserLite 不包含账号名，但运行时的工作区成员数据可能来自更完整的用户对象。
      const accountName = (member as IUser).username ?? "";
      const searchableFields = [
        member.id,
        accountName,
        member.display_name,
        fullName,
        member.email,
        memberDetails?.email,
      ].filter(Boolean);

      return {
        value: member.id,
        query: searchableFields.join(" ").toLowerCase(),
        content: (
          <div className="flex w-full min-w-0 items-center gap-2">
            <div className="shrink-0 pt-0.5">
              <Avatar
                alt={member.display_name}
                fallback={member.display_name?.[0]?.toUpperCase()}
                src={getFileURL(member.avatar_url)}
                size="xs"
              />
            </div>
            <div className="min-w-0">
              <div className="truncate text-13 text-primary">{getMemberDisplayName(member)}</div>
              <div className="truncate text-11 text-tertiary">{member.email ?? memberDetails?.email ?? member.id}</div>
            </div>
          </div>
        ),
      };
    })
    .filter((option) => !!option) as
    | {
        value: string;
        query: string;
        content: React.ReactNode;
      }[]
    | undefined;

  const getDefaultProjectRole = (memberId: string) => {
    const workspaceRole = getWorkspaceMemberDetails(memberId)?.role;
    return Number(workspaceRole ?? EUserPermissions.GUEST) as EUserPermissions;
  };

  const handleMembersChange = (nextMemberIds: string[]) => {
    const previousRoles = getValues("roles");
    const nextRoles = nextMemberIds.reduce<Record<string, EUserPermissions>>((accumulator, memberId) => {
      accumulator[memberId] = previousRoles[memberId] ?? getDefaultProjectRole(memberId);
      return accumulator;
    }, {});

    setValue("memberIds", nextMemberIds, { shouldValidate: true });
    setValue("roles", nextRoles, { shouldValidate: true });
  };

  const toggleTagFilter = (tagId: string) => {
    setSelectedTagIds((current) =>
      current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId]
    );
  };

  const selectFilteredMembers = () => {
    if (selectedTagIds.length === 0 || tagFilteredMemberIds.length === 0) return;
    handleMembersChange(Array.from(new Set([...selectedMemberIds, ...tagFilteredMemberIds])));
  };

  const checkCurrentOptionWorkspaceRole = (value: string) => {
    const currentMemberWorkspaceRole = getWorkspaceMemberDetails(value)?.role;
    if (!value || !currentMemberWorkspaceRole) return ROLE;

    const isGuestOROwner = [EUserPermissions.ADMIN, EUserPermissions.GUEST].includes(
      currentMemberWorkspaceRole as EUserPermissions
    );

    return Object.fromEntries(
      Object.entries(ROLE).filter(([key]) => !isGuestOROwner || [currentMemberWorkspaceRole].includes(parseInt(key)))
    );
  };

  return (
    <ModalCore isOpen={isOpen} handleClose={handleClose} position={EModalPosition.CENTER} width={EModalWidth.XXL}>
      <form onSubmit={handleSubmit(onSubmit)} className="p-5">
        <div className="space-y-5">
          <h3 className="text-16 leading-6 font-medium text-primary">
            {t("project_settings.members.invite_members.title")}
          </h3>
          <div className="mt-2">
            <p className="text-13 text-secondary">{t("project_settings.members.invite_members.sub_heading")}</p>
          </div>

          <div className="space-y-4">
            <section className="space-y-3 rounded-md border border-subtle bg-surface-1 p-3">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div>
                  <h4 className="text-13 font-medium text-primary">{t("project_settings.members.filter_by_tags")}</h4>
                  <p className="mt-0.5 text-11 text-tertiary">{t("project_settings.members.tag_filter_hint")}</p>
                </div>
                <p data-testid="filtered-member-count" className="text-11 text-tertiary" aria-live="polite">
                  {t("project_settings.members.filtered_member_count")}: {tagFilteredMemberIds.length}
                </p>
              </div>

              {tagFilterError ? (
                <p data-testid="tag-filter-error" className="text-12 text-secondary">
                  {t("project_settings.members.tags_load_failed")}
                </p>
              ) : tagFilterLoading ? (
                <p className="text-12 text-tertiary">{t("project_settings.members.loading_tags")}</p>
              ) : availableTagGroups.length === 0 ? (
                <p data-testid="no-available-tags" className="text-12 text-tertiary">
                  {t("project_settings.members.no_available_tags")}
                </p>
              ) : (
                <div className="space-y-2">
                  {availableTagGroups.map((group) => (
                    <div key={group.id} className="space-y-1.5">
                      <p className="text-11 font-medium text-tertiary">{group.name}</p>
                      <div className="flex flex-wrap gap-2">
                        {group.tags.map((tag) => {
                          const selected = selectedTagIds.includes(tag.id);
                          return (
                            <button
                              key={tag.id}
                              type="button"
                              data-testid={`member-tag-${tag.id}`}
                              aria-pressed={selected}
                              onClick={() => toggleTagFilter(tag.id)}
                              className={getMemberTagClassNames(tag, selected, "control")}
                            >
                              {selected && <TickOutline className="size-3 shrink-0" aria-hidden="true" />}
                              <span>{tag.name}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <Button
                variant="secondary"
                size="sm"
                type="button"
                data-testid="select-filtered-members"
                disabled={selectedTagIds.length === 0 || tagFilteredMemberIds.length === 0 || isSubmitting}
                onClick={selectFilteredMembers}
              >
                {t("project_settings.members.select_filtered_members")}（{tagFilteredMemberIds.length}）
              </Button>
            </section>

            <div>
              <Controller
                control={control}
                name="memberIds"
                rules={{
                  required: t("project_settings.members.select_member_required"),
                  validate: (value) => value.length > 0 || t("project_settings.members.select_member_required"),
                }}
                render={({ field }) => {
                  const value = Array.isArray(field.value) ? field.value : [];
                  const firstMember = getWorkspaceMemberDetails(value[0] ?? "")?.member;
                  return (
                    <CustomSearchSelect
                      multiple
                      ariaLabel={t("project_settings.members.invite_members.select_co_worker")}
                      value={value}
                      customButton={
                        <>
                          {value.length > 0 && firstMember ? (
                            <span className="flex min-w-0 items-center gap-2">
                              <span className="truncate">{getMemberDisplayName(firstMember)}</span>
                              {value.length > 1 && (
                                <span className="shrink-0 text-tertiary">
                                  +{value.length - 1} {t("members")}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span>{t("project_settings.members.invite_members.select_co_worker")}</span>
                          )}
                          <ChevronDownOutline className="h-3 w-3 shrink-0" aria-hidden="true" />
                        </>
                      }
                      customButtonClassName="flex min-h-10 w-full items-center justify-between gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-2 text-left text-13 text-secondary transition-colors duration-200 hover:border-strong hover:text-primary focus:outline-none"
                      onChange={(nextValue: string[]) => handleMembersChange(nextValue)}
                      options={options}
                      searchPlaceholder={t("search")}
                      noResultsMessage={t("common.search.no_matches_found")}
                      optionsClassName="w-full min-w-72"
                    />
                  );
                }}
              />
              {errors.memberIds && (
                <span className="mt-1 block text-13 text-danger-primary">{errors.memberIds.message}</span>
              )}
            </div>

            {selectedMemberIds.length > 0 && (
              <div className="divide-y divide-subtle rounded-md border border-subtle bg-surface-1">
                {selectedMemberIds.map((memberId) => {
                  const member = getWorkspaceMemberDetails(memberId)?.member;
                  if (!member) return null;
                  const displayName = getMemberDisplayName(member);

                  return (
                    <div key={memberId} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <Avatar
                          alt={displayName}
                          fallback={displayName?.[0]?.toUpperCase()}
                          src={getFileURL(member.avatar_url)}
                          size="xs"
                        />
                        <div className="min-w-0">
                          <p className="truncate text-13 text-primary">{displayName}</p>
                          <p className="truncate text-11 text-tertiary">{member.email ?? memberId}</p>
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <Controller
                          name={`roles.${memberId}`}
                          control={control}
                          rules={{ required: t("project_settings.members.role_required") }}
                          render={({ field: roleField }) => (
                            <CustomSelect
                              {...roleField}
                              ariaLabel={`${displayName}: ${t("project_settings.members.roles")}`}
                              customButton={
                                <div className="flex w-28 items-center justify-between gap-1 rounded-md border border-subtle px-2.5 py-2 text-left text-13 text-secondary transition-colors duration-200 hover:border-strong hover:text-primary focus:outline-none">
                                  <span className="capitalize">
                                    {roleField.value
                                      ? t(ROLE_DETAILS[roleField.value as EUserPermissions].i18n_title)
                                      : t("project_settings.members.select_role")}
                                  </span>
                                  <ChevronDownOutline className="h-3 w-3 shrink-0" aria-hidden="true" />
                                </div>
                              }
                              input
                            >
                              {Object.entries(checkCurrentOptionWorkspaceRole(memberId)).map(([key]) => {
                                if (parseInt(key) > (currentProjectRole ?? EUserPermissions.GUEST)) return null;

                                return (
                                  <CustomSelect.Option key={key} value={key}>
                                    {t(ROLE_DETAILS[Number(key) as EUserPermissions].i18n_title)}
                                  </CustomSelect.Option>
                                );
                              })}
                            </CustomSelect>
                          )}
                        />
                        <button
                          type="button"
                          className="flex h-8 w-8 items-center justify-center rounded-sm text-secondary transition-colors hover:bg-layer-transparent-hover hover:text-primary focus:outline-none"
                          aria-label={`${t("remove_member")}: ${displayName}`}
                          onClick={() => handleMembersChange(selectedMemberIds.filter((id) => id !== memberId))}
                        >
                          <CloseOutline className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="lg" onClick={handleClose}>
              {t("cancel")}
            </Button>
            <Button variant="primary" size="lg" type="submit" loading={isSubmitting}>
              {isSubmitting ? t("adding_members") : selectedMemberIds.length > 1 ? t("add_members") : t("add_member")}
            </Button>
          </div>
        </div>
      </form>
    </ModalCore>
  );
});
