import { useMemo, useState } from "react";
import { TickOutline } from "@makeplane/propel/icons";
import { Button } from "@plane/propel/button";
import { SearchOutline } from "@makeplane/propel/icons";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import type { IWorkspaceMember, IWorkspaceMemberTagGroup } from "@plane/types";
import { useMember } from "@/hooks/store/use-member";
import { getMemberTagErrorMessage } from "./member-tag-error";
import { getMemberTagClassNames } from "./member-tag-pill";

type Props = {
  workspaceSlug: string;
  memberIds: string[];
  members: IWorkspaceMember[];
  groups: IWorkspaceMemberTagGroup[];
  onClose: () => void;
  onSuccess?: () => void;
};

/** 为多个成员批量添加或移除指定标签。 */
export function BulkMemberTagsEditor({ workspaceSlug, memberIds, members, groups, onClose, onSuccess }: Props) {
  const { workspace } = useMember();
  const [operation, setOperation] = useState<"add" | "remove">("add");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedMembers = useMemo(() => {
    const membersById = new Map(members.map((member) => [member.member.id, member]));
    return memberIds
      .map((memberId) => membersById.get(memberId))
      .filter((member): member is IWorkspaceMember => !!member);
  }, [memberIds, members]);

  const visibleMembers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return selectedMembers;

    return selectedMembers.filter((member) => {
      const fullName = `${member.member.first_name ?? ""} ${member.member.last_name ?? ""}`.trim();
      const searchText = [fullName, member.member.display_name, member.member.email].filter(Boolean).join(" ");
      return searchText.toLowerCase().includes(query);
    });
  }, [searchQuery, selectedMembers]);

  const toggleTag = (tagId: string) => {
    setTagIds((current) => (current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId]));
  };

  const save = async () => {
    if (tagIds.length === 0) return;
    setSaving(true);
    try {
      await workspace.bulkUpdateMemberTags(workspaceSlug, {
        member_ids: memberIds,
        add_tag_ids: operation === "add" ? tagIds : [],
        remove_tag_ids: operation === "remove" ? tagIds : [],
      });
      onSuccess?.();
      onClose();
    } catch (error: unknown) {
      setToast({
        type: TOAST_TYPE.ERROR,
        title: "保存成员标签失败",
        message: getMemberTagErrorMessage(error, "成员标签保存失败，请稍后重试。"),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalCore isOpen handleClose={() => !saving && onClose()} position={EModalPosition.CENTER} width={EModalWidth.XXL}>
      <div className="space-y-5 p-6">
        <div>
          <h2 className="text-16 font-semibold text-primary">批量调整成员标签</h2>
          <p className="mt-1 text-13 text-secondary">已选择 {memberIds.length} 名成员</p>
          <p className="mt-0.5 text-12 text-tertiary" aria-live="polite">
            已选标签：{tagIds.length} 个
          </p>
        </div>
        <div className="space-y-2">
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
          <div className="max-h-48 overflow-y-auto rounded-md border border-subtle bg-surface-1">
            {visibleMembers.length > 0 ? (
              <ul className="divide-y divide-subtle">
                {visibleMembers.map((member) => {
                  const fullName = `${member.member.first_name ?? ""} ${member.member.last_name ?? ""}`.trim();
                  const name = member.member.display_name || fullName || member.member.email || "未命名成员";
                  return (
                    <li key={member.member.id} data-member-id={member.member.id} className="px-3 py-2">
                      <p className="truncate text-13 text-primary">{name}</p>
                      <p className="truncate text-12 text-tertiary">{member.member.email || "未提供邮箱"}</p>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-3 py-6 text-center text-13 text-tertiary">未找到匹配的已选成员。</p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {(["add", "remove"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setOperation(value)}
              className={`rounded-md border px-3 py-1.5 text-12 ${
                operation === value
                  ? "border-accent-primary bg-accent-primary/10 text-accent-primary"
                  : "border-subtle text-secondary hover:bg-surface-2"
              }`}
            >
              {value === "add" ? "添加标签" : "移除标签"}
            </button>
          ))}
        </div>
        <div className="space-y-4">
          {groups.map((group) => (
            <section key={group.id}>
              <h3 className="text-13 font-medium text-primary">{group.name}</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {group.tags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTag(tag.id)}
                    aria-pressed={tagIds.includes(tag.id)}
                    className={getMemberTagClassNames(tag, tagIds.includes(tag.id), "control")}
                  >
                    {tagIds.includes(tag.id) && <TickOutline className="size-3 shrink-0" aria-hidden="true" />}
                    <span>{tag.name}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="lg" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            variant="primary"
            size="lg"
            onClick={() => void save()}
            disabled={tagIds.length === 0}
            loading={saving}
          >
            {operation === "add" ? "添加所选标签" : "移除所选标签"}
          </Button>
        </div>
      </div>
    </ModalCore>
  );
}
