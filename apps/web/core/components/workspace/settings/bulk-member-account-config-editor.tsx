import { useMemo, useState } from "react";
import { EUserPermissions } from "@plane/constants";
import { Button } from "@plane/propel/button";
import { SearchOutline } from "@makeplane/propel/icons";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import type { IWorkspaceMember } from "@plane/types";
import { useMember } from "@/hooks/store/use-member";

type Props = {
  workspaceSlug: string;
  memberIds: string[];
  members: IWorkspaceMember[];
  onClose: () => void;
  onSuccess?: () => void;
};

type AccountOperation = "set" | "cancel";

/** Get a member's display name with first and last name fallback. */
function normalizedName(member: IWorkspaceMember) {
  return `${member.member.first_name ?? ""} ${member.member.last_name ?? ""}`.trim();
}

/** 为选中的工作区成员批量设置或取消反馈运维账号身份。 */
export function BulkMemberAccountConfigEditor({ workspaceSlug, memberIds, members, onClose, onSuccess }: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [operation, setOperation] = useState<AccountOperation>("set");
  const [saving, setSaving] = useState(false);
  const {
    workspace: { bulkUpdateMemberAccounts },
  } = useMember();

  const selectedIds = useMemo(() => new Set(memberIds), [memberIds]);
  const selectedMembers = useMemo(
    () => members.filter((member) => selectedIds.has(member.member.id)),
    [members, selectedIds]
  );
  const memberState = useMemo(
    () =>
      selectedMembers.map((member) => {
        const isEligible =
          member.is_active !== false && member.role === EUserPermissions.MEMBER && !member.member.is_bot;
        return { member, isEligible, isOperationsAccount: member.is_operations_account === true };
      }),
    [selectedMembers]
  );
  const eligible = memberState.filter((item) => item.isEligible);
  const operationsCount = eligible.filter((item) => item.isOperationsAccount).length;
  const normalCount = eligible.length - operationsCount;
  const ineligibleCount = memberState.length - eligible.length;
  const targetCount = operation === "set" ? normalCount : operationsCount;
  const unchangedCount = eligible.length - targetCount;

  const visibleMembers = memberState.filter(({ member }) => {
    const keyword = searchQuery.trim().toLowerCase();
    if (!keyword) return true;
    return [member.member.display_name, normalizedName(member), member.member.email]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(keyword));
  });

  const save = async () => {
    if (saving || ineligibleCount > 0) return;
    setSaving(true);
    try {
      await bulkUpdateMemberAccounts(workspaceSlug, {
        member_ids: memberIds,
        is_operations_account: operation === "set",
      });
      setToast({
        type: TOAST_TYPE.SUCCESS,
        title: "账号配置成功",
        message: operation === "set" ? "所选成员已具备反馈回复权限。" : "所选成员已恢复普通成员权限。",
      });
      onSuccess?.();
      onClose();
    } catch (error: unknown) {
      const err = error as { error?: string };
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "账号配置失败",
        message: err?.error || "账号配置未完成，请稍后重试。",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalCore isOpen handleClose={() => !saving && onClose()} position={EModalPosition.CENTER} width={EModalWidth.XXL}>
      <form
        className="space-y-5 p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div>
          <h2 className="text-16 font-semibold text-primary">批量配置成员账号</h2>
          <p className="mt-1 text-13 text-secondary">已选择 {memberIds.length} 名成员</p>
          <p className="mt-1 text-12 text-secondary" aria-live="polite">
            运维账号：{operationsCount} 名 · 普通成员：{normalCount} 名
            {ineligibleCount > 0 ? ` · 不可配置：${ineligibleCount} 名` : ""}
          </p>
          <p className="mt-1 text-12 text-tertiary" aria-live="polite">
            将影响 {targetCount} 人，{unchangedCount} 人保持不变。运维身份仅用于回复本工作区反馈。
          </p>
        </div>

        <label className="relative block">
          <SearchOutline className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-placeholder" />
          <input
            aria-label="搜索已选成员"
            className="focus:border-accent-primary h-9 w-full rounded-md border border-subtle bg-surface-1 pr-3 pl-8 text-13 outline-none"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="按姓名、显示名或邮箱搜索"
          />
        </label>

        <div className="max-h-56 overflow-y-auto rounded-md border border-subtle bg-surface-1">
          {visibleMembers.length > 0 ? (
            <ul className="divide-y divide-subtle">
              {visibleMembers.map(({ member, isEligible, isOperationsAccount }) => {
                const name =
                  member.member.display_name || normalizedName(member) || member.member.email || "未命名成员";
                const status = !isEligible
                  ? member.is_active === false
                    ? "已停用，不可配置"
                    : member.role === EUserPermissions.ADMIN
                      ? "管理员，不可配置"
                      : "当前角色，不可配置"
                  : isOperationsAccount
                    ? "运维账号"
                    : "普通成员";
                return (
                  <li
                    key={member.member.id}
                    data-member-id={member.member.id}
                    className="flex items-center justify-between gap-3 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-13 text-primary">{name}</p>
                      <p className="truncate text-12 text-tertiary">{member.member.email || "未提供邮箱"}</p>
                    </div>
                    <span className={`shrink-0 text-12 ${isEligible ? "text-secondary" : "text-tertiary"}`}>
                      {status}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-3 py-6 text-center text-13 text-tertiary">未找到匹配的已选成员。</p>
          )}
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label="账号配置操作">
          {(
            [
              ["set", "设为运维"],
              ["cancel", "取消运维"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={operation === value}
              onClick={() => setOperation(value)}
              className={`rounded-md border px-3 py-1.5 text-12 ${
                operation === value
                  ? "border-accent-primary bg-accent-primary/10 text-accent-primary"
                  : "border-subtle text-secondary hover:bg-surface-2"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {ineligibleCount > 0 && (
          <p role="alert" className="text-12 text-danger-primary">
            所选成员包含管理员、访客、机器人或停用成员，请取消选择后重试。
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="lg" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button type="submit" variant="primary" size="lg" loading={saving} disabled={ineligibleCount > 0}>
            {operation === "set" ? "确认设置" : "确认取消"}
          </Button>
        </div>
      </form>
    </ModalCore>
  );
}
