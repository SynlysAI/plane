import { useEffect, useState } from "react";
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import type { IWorkspaceMemberTag, IWorkspaceMemberTagGroup } from "@plane/types";
import { useMember } from "@/hooks/store/use-member";

const TAG_COLOR_CLASS_NAMES: Record<IWorkspaceMemberTag["color"], string> = {
  sage: "border-[#BDCCBF] bg-[#F0F5F0] text-[#466152]",
  sand: "border-[#D8CBB6] bg-[#FAF6EE] text-[#75624B]",
  slate: "border-[#C8CED3] bg-[#F2F4F5] text-[#53616B]",
  mist: "border-[#C7D3D4] bg-[#F0F5F5] text-[#456467]",
  clay: "border-[#D9C4B9] bg-[#FAF2EE] text-[#815E50]",
  moss: "border-[#C7D1B5] bg-[#F3F6ED] text-[#5B6B47]",
};

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
                      className={`rounded-md border px-2.5 py-1.5 text-12 ${
                        checked ? TAG_COLOR_CLASS_NAMES[tag.color] : "border-subtle text-secondary hover:bg-surface-2"
                      }`}
                    >
                      {tag.name}
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
