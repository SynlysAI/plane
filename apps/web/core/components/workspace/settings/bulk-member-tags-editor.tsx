import { useState } from "react";
import { Button } from "@plane/propel/button";
import { EModalPosition, EModalWidth, ModalCore } from "@plane/ui";
import type { IWorkspaceMemberTagGroup } from "@plane/types";
import { useMember } from "@/hooks/store/use-member";

const TAG_COLOR_CLASS_NAMES: Record<IWorkspaceMemberTagGroup["tags"][number]["color"], string> = {
  sage: "border-[#BDCCBF] bg-[#F0F5F0] text-[#466152]",
  sand: "border-[#D8CBB6] bg-[#FAF6EE] text-[#75624B]",
  slate: "border-[#C8CED3] bg-[#F2F4F5] text-[#53616B]",
  mist: "border-[#C7D3D4] bg-[#F0F5F5] text-[#456467]",
  clay: "border-[#D9C4B9] bg-[#FAF2EE] text-[#815E50]",
  moss: "border-[#C7D1B5] bg-[#F3F6ED] text-[#5B6B47]",
};

type Props = {
  workspaceSlug: string;
  memberIds: string[];
  groups: IWorkspaceMemberTagGroup[];
  onClose: () => void;
};

/** 为多个成员批量添加或移除指定标签。 */
export function BulkMemberTagsEditor({ workspaceSlug, memberIds, groups, onClose }: Props) {
  const { workspace } = useMember();
  const [operation, setOperation] = useState<"add" | "remove">("add");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

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
      onClose();
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
                    className={`rounded-md border px-2.5 py-1.5 text-12 ${
                      tagIds.includes(tag.id)
                        ? TAG_COLOR_CLASS_NAMES[tag.color]
                        : "border-subtle text-secondary hover:bg-surface-2"
                    }`}
                  >
                    {tag.name}
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
