"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Combobox } from "@headlessui/react";

import { Button } from "@plane/propel/button";
import { ChevronExpandOutline, TickOutline } from "@makeplane/propel/icons";
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
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [memberRole, setMemberRole] = useState<"ADMIN" | "MEMBER">("MEMBER");
  const [assignableMembers, setAssignableMembers] = useState<{ id: string; name: string; email: string }[]>([]);
  const [renameName, setRenameName] = useState(organization?.name ?? "");
  const [deleteTarget, setDeleteTarget] = useState(defaultOrganization?.id ?? "uncategorized");
  const [isSaving, setIsSaving] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const sortedAssignableMembers = useMemo(
    () =>
      // oxlint-disable-next-line unicorn/no-array-sort -- TypeScript target does not include Array#toSorted.
      [...assignableMembers].sort((a, b) =>
        (a.name || a.email).localeCompare(b.name || b.email, ["zh-Hans", "en"], {
          sensitivity: "base",
        })
      ),
    [assignableMembers]
  );
  const filteredMembers = useMemo(() => {
    const query = memberQuery.trim().toLowerCase();
    if (!query) return sortedAssignableMembers;
    return sortedAssignableMembers.filter(
      (member) => (member.name || "").toLowerCase().includes(query) || member.email.toLowerCase().includes(query)
    );
  }, [memberQuery, sortedAssignableMembers]);

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
    if (selectedMembers.length === 0) return;
    const succeeded = await runMutation(
      () =>
        Promise.all(
          selectedMembers.map((memberId) =>
            service.addAdministrativeOrganizationMember(workspaceSlug, organization.id, memberId, memberRole)
          )
        ),
      "成员权限已更新。"
    );
    if (succeeded) {
      setSelectedMembers([]);
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
          <div
            className="mt-4 flex flex-col gap-1 text-12 text-secondary"
            role="group"
            aria-labelledby="organization-member-label"
          >
            <span id="organization-member-label">工作区成员</span>
            <Combobox
              as="div"
              multiple
              value={selectedMembers}
              onChange={(value: string[]) => {
                setSelectedMembers(value);
                setMemberQuery("");
              }}
            >
              <div className="relative">
                <Combobox.Input
                  aria-labelledby="organization-member-label"
                  className="w-full rounded-md border border-subtle bg-surface-1 px-2 py-2 pr-8 text-13 text-primary outline-none placeholder:text-placeholder"
                  placeholder={
                    selectedMembers.length > 0
                      ? `已选择 ${selectedMembers.length} 位成员，继续搜索姓名或邮箱`
                      : "搜索姓名或邮箱"
                  }
                  displayValue={() => ""}
                  value={memberQuery}
                  onChange={(event) => setMemberQuery(event.target.value)}
                />
                <Combobox.Button
                  className="absolute inset-y-0 right-0 flex items-center px-2 text-tertiary"
                  aria-label="展开工作区成员"
                >
                  <ChevronExpandOutline className="size-4 shrink-0" aria-hidden="true" />
                </Combobox.Button>
                <Combobox.Options className="vertical-scrollbar absolute z-10 mt-1 scrollbar-md max-h-48 w-full overflow-auto rounded-md border border-subtle bg-surface-1 p-1 shadow-raised-200">
                  {filteredMembers.length === 0 ? (
                    <li className="px-2 py-1.5 text-13 text-placeholder">没有找到匹配的成员</li>
                  ) : (
                    filteredMembers.map((member) => {
                      const isSelected = selectedMembers.includes(member.id);
                      return (
                        <Combobox.Option
                          key={member.id}
                          value={member.id}
                          className={({ active }) =>
                            `flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 select-none ${
                              active ? "bg-surface-2" : ""
                            }`
                          }
                        >
                          <span
                            className={`grid size-4 shrink-0 place-items-center rounded border ${
                              isSelected ? "border-accent-primary bg-accent-primary text-on-color" : "border-strong"
                            }`}
                            aria-hidden="true"
                          >
                            {isSelected && <TickOutline className="size-3" />}
                          </span>
                          <span className="min-w-0 shrink truncate text-13 text-primary">
                            {member.name || member.email}
                          </span>
                          {member.name && (
                            <span className="min-w-0 truncate text-11 text-tertiary">{member.email}</span>
                          )}
                        </Combobox.Option>
                      );
                    })
                  )}
                </Combobox.Options>
              </div>
            </Combobox>
            <span className="text-11 text-tertiary">可搜索并选择多个成员。</span>
          </div>
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
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={selectedMembers.length === 0}
              loading={isSaving}
            >
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
