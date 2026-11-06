/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { Disclosure } from "@headlessui/react";
// plane imports
import { ROLE, EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { DeactivatedUserOutline, DeleteOutline, EditOutline } from "@makeplane/propel/icons";
import { Pill, EPillVariant, EPillSize } from "@plane/propel/pill";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import type { IUser, IWorkspaceMember } from "@plane/types";
// plane ui
import { CustomSelect, PopoverMenu } from "@plane/ui";
// helpers
import { getFileURL } from "@plane/utils";
// hooks
import { useMember } from "@/hooks/store/use-member";
import { useUser, useUserPermissions } from "@/hooks/store/user";

export type RowData = IWorkspaceMember;

type NameProps = {
  rowData: RowData;
  workspaceSlug: string;
  isAdmin: boolean;
  currentUser: IUser | undefined;
  setRemoveMemberModal: (rowData: RowData) => void;
};

type AccountTypeProps = {
  rowData: RowData;
  workspaceSlug: string;
};

export function NameColumn(props: NameProps) {
  const { rowData, workspaceSlug, isAdmin, currentUser, setRemoveMemberModal } = props;
  // derived values
  const { avatar_url, display_name, email, first_name, id, last_name } = rowData.member;
  const fullName = [first_name, last_name].filter(Boolean).join(" ");
  const isSuspended = rowData.is_active === false;

  return (
    <Disclosure>
      {() => (
        <div className="group relative">
          <div className="flex w-72 min-w-0 items-center justify-between gap-x-4">
            <div className="flex min-w-0 flex-1 items-center gap-x-2">
              {isSuspended ? (
                <div className="shrink-0 rounded-full bg-layer-1">
                  <DeactivatedUserOutline className="size-6 text-placeholder" />
                </div>
              ) : avatar_url && avatar_url.trim() !== "" ? (
                <Link href={`/${workspaceSlug}/profile/${id}`} className="shrink-0">
                  <span className="relative flex size-6 items-center justify-center rounded-full text-on-color capitalize">
                    <img
                      src={getFileURL(avatar_url)}
                      className="absolute top-0 left-0 h-full w-full rounded-full object-cover"
                      alt={display_name || email}
                    />
                  </span>
                </Link>
              ) : (
                <Link href={`/${workspaceSlug}/profile/${id}`} className="shrink-0">
                  <span className="relative flex size-6 items-center justify-center rounded-full bg-layer-3 text-11 text-tertiary capitalize">
                    {(email ?? display_name ?? "?")[0]}
                  </span>
                </Link>
              )}
              <span className={`min-w-0 truncate ${isSuspended ? "text-placeholder" : ""}`} title={fullName}>
                {fullName}
              </span>
            </div>

            {!isSuspended && (isAdmin || id === currentUser?.id) && (
              <PopoverMenu
                data={[""]}
                keyExtractor={(item) => item}
                popoverClassName="justify-end"
                buttonClassName="outline-none	origin-center rotate-90 size-8 aspect-square flex-shrink-0 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity"
                render={() => (
                  <button
                    type="button"
                    className="flex cursor-pointer items-center gap-x-3"
                    onClick={() => setRemoveMemberModal(rowData)}
                  >
                    <DeleteOutline className="size-3.5 align-middle" /> {id === currentUser?.id ? "Leave " : "Remove "}
                  </button>
                )}
              />
            )}
          </div>
        </div>
      )}
    </Disclosure>
  );
}

type EmailProps = {
  rowData: RowData;
  workspaceSlug: string;
  isAdmin: boolean;
};

/** 在成员邮箱列提供管理员专属的行内修正入口。 */
export const EmailColumn = observer(function EmailColumn(props: EmailProps) {
  const { rowData, workspaceSlug, isAdmin } = props;
  const {
    workspace: { updateMemberEmail },
  } = useMember();
  const [isEditing, setIsEditing] = useState(false);
  const [draftEmail, setDraftEmail] = useState(rowData.member.email ?? "");
  const [isSaving, setIsSaving] = useState(false);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const isSuspended = rowData.is_active === false;
  const canEdit = isAdmin && !isSuspended && !rowData.member.is_bot;

  useEffect(() => {
    if (isEditing) emailInputRef.current?.focus();
  }, [isEditing]);

  /** 取消邮箱编辑并恢复列表中的当前值。 */
  const cancelEdit = () => {
    if (isSaving) return;
    setDraftEmail(rowData.member.email ?? "");
    setIsEditing(false);
  };

  /** 保存邮箱并通过 toast 显示服务端结果。 */
  const saveEmail = async () => {
    const email = draftEmail.trim();
    if (!workspaceSlug || !email || email.toLowerCase() === (rowData.member.email ?? "").toLowerCase() || isSaving)
      return;

    setIsSaving(true);
    try {
      await updateMemberEmail(workspaceSlug.toString(), rowData.member.id, email);
      setIsEditing(false);
      setToast({ type: TOAST_TYPE.SUCCESS, title: "邮箱已更新", message: "登录邮箱已修正，并已通知新邮箱地址。" });
    } catch (error: unknown) {
      const err = error as { error?: string | string[] };
      const message = Array.isArray(err?.error) ? err.error[0] : err?.error;
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "邮箱更新失败",
        message: message || "邮箱未更新，请检查地址后重试。",
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isEditing) {
    return (
      <div
        className="flex w-48 min-w-0 items-center gap-1"
        onBlur={(event) => {
          const relatedTarget = event.relatedTarget as Node | null;
          if (!relatedTarget || !event.currentTarget.contains(relatedTarget)) cancelEdit();
        }}
      >
        <input
          ref={emailInputRef}
          aria-label="修正邮箱"
          type="email"
          value={draftEmail}
          disabled={isSaving}
          onChange={(event) => setDraftEmail(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveEmail();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancelEdit();
            }
          }}
          className="focus:border-accent-primary h-7 min-w-0 flex-1 rounded-md border border-subtle bg-surface-1 px-2 text-12 text-primary outline-none"
        />
        <button
          type="button"
          aria-label="保存邮箱"
          data-email-editor-control
          disabled={isSaving || !draftEmail.trim()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void saveEmail()}
          className="shrink-0 text-11 text-accent-primary disabled:text-placeholder"
        >
          {isSaving ? "保存中" : "保存"}
        </button>
        <button
          type="button"
          aria-label="取消编辑邮箱"
          data-email-editor-control
          disabled={isSaving}
          onMouseDown={(event) => event.preventDefault()}
          onClick={cancelEdit}
          className="shrink-0 text-11 text-tertiary disabled:text-placeholder"
        >
          取消
        </button>
      </div>
    );
  }

  return (
    <div className="group flex w-48 min-w-0 items-center justify-between gap-1">
      <div
        className={`min-w-0 flex-1 truncate ${isSuspended ? "text-placeholder" : ""}`}
        title={rowData.member.email ?? ""}
      >
        {rowData.member.email}
      </div>
      {canEdit && (
        <button
          type="button"
          aria-label="修改邮箱"
          title="修改邮箱"
          onClick={() => {
            setDraftEmail(rowData.member.email ?? "");
            setIsEditing(true);
          }}
          className="flex h-6 shrink-0 items-center gap-1 rounded px-1 text-11 text-tertiary opacity-100 transition-opacity hover:bg-layer-1 hover:text-primary focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        >
          <EditOutline className="size-3" />
          <span>修改</span>
        </button>
      )}
    </div>
  );
});

export const AccountTypeColumn = observer(function AccountTypeColumn(props: AccountTypeProps) {
  const { rowData, workspaceSlug } = props;
  // form info
  const {
    control,
    formState: { errors },
  } = useForm();
  // store hooks
  const { allowPermissions } = useUserPermissions();

  const {
    workspace: { updateMember },
  } = useMember();
  const { data: currentUser } = useUser();

  // derived values
  const isCurrentUser = currentUser?.id === rowData.member.id;
  const isAdminRole = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);
  const isRoleNonEditable = isCurrentUser || !isAdminRole;
  const isSuspended = rowData.is_active === false;
  const operationsMarker = rowData.is_operations_account ? (
    <span className="text-11 text-tertiary">运维账号</span>
  ) : null;

  return (
    <>
      {isSuspended ? (
        <div className="flex w-32">
          <Pill variant={EPillVariant.DEFAULT} size={EPillSize.SM} className="border-none">
            Suspended
          </Pill>
        </div>
      ) : isRoleNonEditable ? (
        <div className="flex w-32 flex-col gap-0.5">
          <span>{ROLE[rowData.role]}</span>
          {operationsMarker}
        </div>
      ) : (
        <Controller
          name="role"
          control={control}
          rules={{ required: "Role is required." }}
          render={({ field: { value } }) => (
            <CustomSelect
              value={value as EUserPermissions}
              onChange={async (nextValue: EUserPermissions) => {
                if (!workspaceSlug) return;
                try {
                  await updateMember(workspaceSlug.toString(), rowData.member.id, { role: nextValue });
                } catch (err: unknown) {
                  const error = err as { error?: string | string[] };
                  const errorString = Array.isArray(error?.error) ? error.error[0] : error?.error;

                  setToast({
                    type: TOAST_TYPE.ERROR,
                    title: "Error!",
                    message: errorString ?? "An error occurred while updating member role. Please try again.",
                  });
                }
              }}
              label={
                <div className="flex flex-col items-start gap-0.5">
                  <span>{ROLE[rowData.role]}</span>
                  {operationsMarker}
                </div>
              }
              buttonClassName={`!px-0 !justify-start hover:bg-surface-1 ${errors.role ? "border-danger-strong" : "border-none"}`}
              className="w-32 rounded-md p-0"
              input
            >
              {Object.keys(ROLE).map((item) => (
                <CustomSelect.Option key={item} value={item as unknown as EUserPermissions}>
                  {ROLE[item as unknown as keyof typeof ROLE]}
                </CustomSelect.Option>
              ))}
            </CustomSelect>
          )}
        />
      )}
    </>
  );
});
