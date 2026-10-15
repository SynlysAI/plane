"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EModalWidth, Input, ModalCore } from "@plane/ui";

import { ResearchNavigationService, type TAdministrativeOrganization } from "@/services/research/navigation.service";

const service = new ResearchNavigationService();

export type AdministrativeOrganizationManagerAction = "members" | "rename" | "delete";

type Props = {
  action: AdministrativeOrganizationManagerAction;
  organizationId: string;
  workspaceSlug: string;
  organizations: TAdministrativeOrganization[];
  defaultOrganization?: TAdministrativeOrganization;
  onClose: () => void;
  onUpdated: () => Promise<void>;
};

/** 从服务端错误中提取可读消息。 */
function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message);
  }
  return "请稍后重试";
}

/** 提供行政组织成员、重命名和删除的独立管理弹窗。 */
export function AdministrativeOrganizationManager({
  action,
  organizationId,
  workspaceSlug,
  organizations,
  defaultOrganization,
  onClose,
  onUpdated,
}: Props) {
  const organization = organizations.find((item) => item.id === organizationId);
  const currentOrganizationId = organization?.id;
  const [managerAction, setManagerAction] = useState(action);
  const [selectedMember, setSelectedMember] = useState("");
  const [memberRole, setMemberRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const [assignableMembers, setAssignableMembers] = useState<{ id: string; name: string; email: string }[]>([]);
  const [renameName, setRenameName] = useState(organization?.name ?? "");
  const [deleteTarget, setDeleteTarget] = useState(defaultOrganization?.id ?? "uncategorized");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setManagerAction(action);
    setRenameName(organization?.name ?? "");
  }, [action, organization?.name]);

  useEffect(() => {
    if (managerAction !== "members" || !currentOrganizationId) return;
    service
      .getAssignableAdministrativeOrganizationMembers(workspaceSlug, currentOrganizationId)
      .then(setAssignableMembers)
      .catch(() => setAssignableMembers([]));
  }, [currentOrganizationId, managerAction, workspaceSlug]);

  const runMutation = useCallback(
    async (mutation: () => Promise<unknown>, successMessage: string) => {
      setIsSaving(true);
      try {
        await mutation();
        await onUpdated();
        setToast({ type: TOAST_TYPE.SUCCESS, title: "组织已更新", message: successMessage });
        return true;
      } catch (error) {
        setToast({ type: TOAST_TYPE.ERROR, title: "组织操作失败", message: errorMessage(error) });
        return false;
      } finally {
        setIsSaving(false);
      }
    },
    [onUpdated]
  );

  const refreshAssignableMembers = useCallback(() => {
    if (!currentOrganizationId) return;
    service
      .getAssignableAdministrativeOrganizationMembers(workspaceSlug, currentOrganizationId)
      .then(setAssignableMembers)
      .catch(() => setAssignableMembers([]));
  }, [currentOrganizationId, workspaceSlug]);

  if (!organization) return null;

  const submitMember = async () => {
    if (!selectedMember) return;
    const succeeded = await runMutation(
      () => service.addAdministrativeOrganizationMember(workspaceSlug, organization.id, selectedMember, memberRole),
      "成员权限已更新。"
    );
    if (succeeded) {
      setSelectedMember("");
      refreshAssignableMembers();
    }
  };

  const changeMemberRole = async (memberId: string, role: "ADMIN" | "MEMBER") => {
    await runMutation(
      () => service.updateAdministrativeOrganizationMember(workspaceSlug, organization.id, memberId, role),
      role === "ADMIN" ? "成员已成为组织管理员。" : "成员已恢复为普通成员。"
    );
  };

  const removeMember = async (memberId: string) => {
    await runMutation(
      () => service.removeAdministrativeOrganizationMember(workspaceSlug, organization.id, memberId),
      "成员已移出组织，单独加入的项目权限保持不变。"
    );
    refreshAssignableMembers();
  };

  const submitRename = async () => {
    const name = renameName.trim();
    if (!name) return;
    const succeeded = await runMutation(
      () => service.updateAdministrativeOrganization(workspaceSlug, organization.id, name),
      "组织名称已保存。"
    );
    if (succeeded) onClose();
  };

  const submitDelete = async () => {
    const succeeded = await runMutation(
      () => service.deleteAdministrativeOrganization(workspaceSlug, organization.id, deleteTarget),
      "组织已删除，项目已迁移。"
    );
    if (succeeded) onClose();
  };

  return (
    <>
      <ModalCore isOpen={managerAction === "members"} handleClose={() => !isSaving && onClose()} width={EModalWidth.SM}>
        <form
          className="p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitMember();
          }}
        >
          <h3 className="text-15 font-semibold">管理 {organization.name} 成员</h3>
          <p className="mt-1 text-12 text-secondary">
            组织成员继承组织内项目的只读权限；项目编辑权限仍由项目角色决定。
          </p>
          <label htmlFor="organization-member" className="mt-4 flex flex-col gap-1 text-12 text-secondary">
            工作区成员
            <select
              id="organization-member"
              className="rounded-md border border-subtle bg-surface-1 px-2 py-2 text-13 text-primary"
              value={selectedMember}
              onChange={(event) => setSelectedMember(event.target.value)}
            >
              <option value="">选择成员</option>
              {assignableMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name || member.email}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="organization-member-role" className="mt-3 flex flex-col gap-1 text-12 text-secondary">
            组织角色
            <select
              id="organization-member-role"
              className="rounded-md border border-subtle bg-surface-1 px-2 py-2 text-13 text-primary"
              value={memberRole}
              onChange={(event) => setMemberRole(event.target.value as "ADMIN" | "MEMBER")}
            >
              <option value="MEMBER">成员</option>
              <option value="ADMIN">组织管理员</option>
            </select>
          </label>
          <div className="mt-4 flex justify-end">
            <Button type="submit" variant="secondary" size="sm" disabled={!selectedMember} loading={isSaving}>
              添加成员
            </Button>
          </div>
          {organization.members.length > 0 && (
            <div className="mt-4 border-t border-subtle">
              {organization.members.map((member) => (
                <div key={member.id} className="flex items-center gap-2 border-b border-subtle py-2 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-13 text-primary">{member.name}</p>
                    <p className="truncate text-11 text-tertiary">{member.email}</p>
                  </div>
                  <select
                    aria-label={`${member.name} 的组织角色`}
                    className="rounded-md border border-subtle bg-surface-1 px-1.5 py-1 text-12 text-primary"
                    value={member.role}
                    disabled={isSaving}
                    onChange={(event) => void changeMemberRole(member.id, event.target.value as "ADMIN" | "MEMBER")}
                  >
                    <option value="MEMBER">成员</option>
                    <option value="ADMIN">组织管理员</option>
                  </select>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={isSaving || member.id === organization.created_by}
                    onClick={() => void removeMember(member.id)}
                  >
                    移除
                  </Button>
                </div>
              ))}
            </div>
          )}
          <div className="mt-5 flex justify-end">
            <Button type="button" variant="secondary" size="sm" disabled={isSaving} onClick={onClose}>
              关闭
            </Button>
          </div>
        </form>
      </ModalCore>

      <ModalCore isOpen={managerAction === "rename"} handleClose={() => !isSaving && onClose()} width={EModalWidth.SM}>
        <form
          className="p-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          <h3 className="text-15 font-semibold">重命名组织</h3>
          <label htmlFor="organization-name" className="mt-4 flex flex-col gap-1 text-12 text-secondary">
            组织名称
            <Input
              id="organization-name"
              value={renameName}
              maxLength={255}
              onChange={(event) => setRenameName(event.target.value)}
            />
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={isSaving} onClick={onClose}>
              取消
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={isSaving}>
              保存
            </Button>
          </div>
        </form>
      </ModalCore>

      <ModalCore isOpen={managerAction === "delete"} handleClose={() => !isSaving && onClose()} width={EModalWidth.SM}>
        <div className="p-5">
          <h3 className="text-15 font-semibold">删除组织</h3>
          <p className="mt-1 text-12 text-secondary">组织成员会同时失去继承访问；请先为组织内项目选择迁移位置。</p>
          <label htmlFor="organization-delete-target" className="mt-4 flex flex-col gap-1 text-12 text-secondary">
            项目移动到
            <select
              id="organization-delete-target"
              className="rounded-md border border-subtle bg-surface-1 px-2 py-1.5 text-13 text-primary"
              value={deleteTarget}
              onChange={(event) => setDeleteTarget(event.target.value)}
            >
              {defaultOrganization ? (
                <option value={defaultOrganization.id}>公共</option>
              ) : (
                <option value="uncategorized">公共</option>
              )}
              {organizations
                .filter((item) => !item.is_default && item.can_manage && item.id !== organization.id)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="mt-5 flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={isSaving} onClick={onClose}>
              取消
            </Button>
            <Button
              variant="error-fill"
              size="sm"
              loading={isSaving}
              disabled={deleteTarget === "uncategorized"}
              onClick={() => void submitDelete()}
            >
              删除组织
            </Button>
          </div>
        </div>
      </ModalCore>
    </>
  );
}
