import { useEffect, useState } from "react";
import { TickOutline } from "@makeplane/propel/icons";
import { Button } from "@plane/propel/button";
import { TOAST_TYPE, setToast } from "@plane/propel/toast";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import type { IWorkspaceMemberTag, IWorkspaceMemberTagGroup } from "@plane/types";
import { useMember } from "@/hooks/store/use-member";
import { getMemberTagErrorMessage } from "./member-tag-error";
import { getMemberTagClassNames } from "./member-tag-pill";

type Props = {
  workspaceSlug: string;
  memberId: string;
  memberName: string;
  groups: IWorkspaceMemberTagGroup[];
  selectedTags: IWorkspaceMemberTag[];
  onClose: () => void;
};

/** 管理员为单个工作区成员替换标签集合。 */
export function MemberTagsEditor({ workspaceSlug, memberId, memberName, groups, selectedTags, onClose }: Props) {
  const { workspace } = useMember();
  const [selected, setSelected] = useState<string[]>(selectedTags.map((tag) => tag.id));
  const [saving, setSaving] = useState(false);

  useEffect(() => setSelected(selectedTags.map((tag) => tag.id)), [selectedTags]);

  const toggleTag = (tagId: string) => {
    setSelected((current) => (current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId]));
  };

  const save = async () => {
    setSaving(true);
    try {
      await workspace.updateMemberTags(workspaceSlug, memberId, selected);
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
          <h2 className="text-16 font-semibold text-primary">编辑成员标签</h2>
          <p className="mt-1 text-13 text-secondary">{memberName}</p>
          <p className="mt-0.5 text-12 text-tertiary" aria-live="polite">
            已选标签：{selected.length} 个
          </p>
        </div>
        <div className="space-y-4">
          {groups.map((group) => (
            <section key={group.id}>
              <h3 className="text-13 font-medium text-primary">{group.name}</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {group.tags.map((tag) => {
                  const checked = selected.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() => toggleTag(tag.id)}
                      aria-pressed={checked}
                      className={getMemberTagClassNames(tag, checked, "control")}
                    >
                      {checked && <TickOutline className="size-3 shrink-0" aria-hidden="true" />}
                      <span>{tag.name}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {groups.length === 0 && <p className="text-13 text-tertiary">管理员尚未配置标签组。</p>}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="lg" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" size="lg" onClick={() => void save()} loading={saving}>
            保存标签
          </Button>
        </div>
      </div>
    </ModalCore>
  );
}
