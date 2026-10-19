/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import useSWR from "swr";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { Button } from "@plane/propel/button";
import type { IWorkspaceMemberTag, IWorkspaceMemberTagGroup } from "@plane/types";
import { NotAuthorizedView } from "@/components/auth-screens/not-authorized-view";
import { PageHead } from "@/components/core/page-title";
import { SettingsContentWrapper } from "@/components/settings/content-wrapper";
import { SettingsHeading } from "@/components/settings/heading";
import { useMember } from "@/hooks/store/use-member";
import { useUserPermissions } from "@/hooks/store/user";
import { useWorkspace } from "@/hooks/store/use-workspace";
import { WorkspaceService } from "@/services/workspace.service";
import type { Route } from "./+types/page";
import { MemberTagsWorkspaceSettingsHeader } from "./header";

const COLOR_OPTIONS: IWorkspaceMemberTag["color"][] = ["sage", "sand", "slate", "mist", "clay", "moss"];
const workspaceService = new WorkspaceService();

/** 管理工作区成员标签组和标签定义。 */
const MemberTagsSettingsPage = observer(function MemberTagsSettingsPage({ params }: Route.ComponentProps) {
  const { workspaceSlug } = params;
  const { currentWorkspace } = useWorkspace();
  const { allowPermissions, workspaceUserInfo } = useUserPermissions();
  const { workspace } = useMember();
  const [groups, setGroups] = useState<IWorkspaceMemberTagGroup[]>([]);
  const [groupName, setGroupName] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupName, setEditingGroupName] = useState("");
  const [editingTagId, setEditingTagId] = useState<string | null>(null);
  const [editingTagName, setEditingTagName] = useState("");
  const [editingTagColor, setEditingTagColor] = useState<IWorkspaceMemberTag["color"]>("sage");
  const [newTag, setNewTag] = useState<Record<string, { name: string; color: IWorkspaceMemberTag["color"] }>>({});
  const isAdmin = allowPermissions([EUserPermissions.ADMIN], EUserPermissionsLevel.WORKSPACE);

  useSWR(isAdmin ? `WORKSPACE_MEMBER_TAG_GROUPS_${workspaceSlug}` : null, async () => {
    const result = await workspace.fetchWorkspaceMemberTagGroups(workspaceSlug);
    setGroups(result);
    return result;
  });

  useEffect(() => {
    setGroups(workspace.workspaceMemberTagGroups[workspaceSlug] ?? []);
  }, [workspace.workspaceMemberTagGroups, workspaceSlug]);

  if (workspaceUserInfo && !isAdmin) return <NotAuthorizedView section="settings" className="h-auto" />;

  const createGroup = async () => {
    if (!groupName.trim()) return;
    const group = await workspaceService.createWorkspaceMemberTagGroup(workspaceSlug, { name: groupName.trim() });
    setGroups((current) => [...current, group]);
    setGroupName("");
  };

  const createTag = async (group: IWorkspaceMemberTagGroup) => {
    const draft = newTag[group.id];
    if (!draft?.name.trim()) return;
    const tag = await workspaceService.createWorkspaceMemberTag(workspaceSlug, group.id, draft);
    setGroups((current) =>
      current.map((item) => (item.id === group.id ? { ...item, tags: [...item.tags, tag] } : item))
    );
    setNewTag((current) => ({ ...current, [group.id]: { name: "", color: "sage" } }));
  };

  const deleteGroup = async (group: IWorkspaceMemberTagGroup) => {
    if (!window.confirm(`删除标签组“${group.name}”及其标签？`)) return;
    await workspaceService.deleteWorkspaceMemberTagGroup(workspaceSlug, group.id);
    setGroups((current) => current.filter((item) => item.id !== group.id));
  };

  const deleteTag = async (group: IWorkspaceMemberTagGroup, tag: IWorkspaceMemberTag) => {
    if (!window.confirm(`删除标签“${tag.name}”？`)) return;
    await workspaceService.deleteWorkspaceMemberTag(workspaceSlug, tag.id);
    setGroups((current) =>
      current.map((item) =>
        item.id === group.id ? { ...item, tags: item.tags.filter((value) => value.id !== tag.id) } : item
      )
    );
  };

  const saveGroup = async (group: IWorkspaceMemberTagGroup) => {
    const name = editingGroupName.trim();
    if (!name) return;
    const updated = await workspaceService.updateWorkspaceMemberTagGroup(workspaceSlug, group.id, { name });
    setGroups((current) => current.map((item) => (item.id === group.id ? { ...item, ...updated } : item)));
    setEditingGroupId(null);
  };

  const saveTag = async (group: IWorkspaceMemberTagGroup, tag: IWorkspaceMemberTag) => {
    const name = editingTagName.trim();
    if (!name) return;
    const updated = await workspaceService.updateWorkspaceMemberTag(workspaceSlug, tag.id, {
      name,
      color: editingTagColor,
    });
    setGroups((current) =>
      current.map((item) =>
        item.id === group.id
          ? { ...item, tags: item.tags.map((value) => (value.id === tag.id ? updated : value)) }
          : item
      )
    );
    setEditingTagId(null);
  };

  const moveTag = async (group: IWorkspaceMemberTagGroup, tagId: string, direction: -1 | 1) => {
    const sourceIndex = group.tags.findIndex((tag) => tag.id === tagId);
    const destinationIndex = sourceIndex + direction;
    if (sourceIndex < 0 || destinationIndex < 0 || destinationIndex >= group.tags.length) return;
    const reorderedTags = [...group.tags];
    [reorderedTags[sourceIndex], reorderedTags[destinationIndex]] = [
      reorderedTags[destinationIndex],
      reorderedTags[sourceIndex],
    ];
    const updatedTags = await Promise.all(
      reorderedTags.map((tag, index) =>
        workspaceService.updateWorkspaceMemberTag(workspaceSlug, tag.id, { sort_order: (index + 1) * 10000 })
      )
    );
    setGroups((current) => current.map((item) => (item.id === group.id ? { ...item, tags: updatedTags } : item)));
  };

  return (
    <SettingsContentWrapper header={<MemberTagsWorkspaceSettingsHeader />}>
      <PageHead title={currentWorkspace?.name ? `${currentWorkspace.name} - 成员标签` : "成员标签"} />
      <div className="w-full">
        <SettingsHeading title="成员标签" description="配置成员分组标签，管理员可在成员页面为成员分配标签。" />
        <div className="mt-5 flex items-center gap-2 border-b border-subtle pb-5">
          <input
            className="h-9 w-64 rounded-md border border-subtle bg-surface-1 px-3 text-13"
            value={groupName}
            onChange={(event) => setGroupName(event.target.value)}
            placeholder="新标签组名称"
          />
          <Button variant="primary" size="lg" onClick={() => void createGroup()}>
            新建标签组
          </Button>
        </div>
        <div className="divide-y divide-subtle">
          {groups.map((group) => {
            const draft = newTag[group.id] ?? { name: "", color: "sage" as const };
            return (
              <section key={group.id} className="py-5">
                <div className="flex items-center justify-between">
                  <div>
                    {editingGroupId === group.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          className="h-8 rounded-md border border-subtle bg-surface-1 px-2 text-13"
                          value={editingGroupName}
                          onChange={(event) => setEditingGroupName(event.target.value)}
                        />
                        <Button variant="secondary" size="sm" onClick={() => void saveGroup(group)}>
                          保存
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="text-15 font-medium text-primary hover:underline"
                        onClick={() => {
                          setEditingGroupId(group.id);
                          setEditingGroupName(group.name);
                        }}
                      >
                        {group.name}
                      </button>
                    )}
                    <p className="mt-1 text-12 text-tertiary">{group.tags.length} 个标签</p>
                  </div>
                  <Button variant="secondary" size="sm" onClick={() => void deleteGroup(group)}>
                    删除标签组
                  </Button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {group.tags.map((tag) =>
                    editingTagId === tag.id ? (
                      <div
                        key={tag.id}
                        className="flex items-center gap-1 rounded-md border border-subtle bg-surface-2 px-1.5 py-1"
                      >
                        <input
                          className="h-6 w-28 bg-transparent text-12 outline-none"
                          value={editingTagName}
                          onChange={(event) => setEditingTagName(event.target.value)}
                        />
                        <select
                          className="h-6 bg-transparent text-11"
                          value={editingTagColor}
                          onChange={(event) => setEditingTagColor(event.target.value as IWorkspaceMemberTag["color"])}
                        >
                          {COLOR_OPTIONS.map((color) => (
                            <option key={color} value={color}>
                              {color}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="text-11 text-accent-primary"
                          onClick={() => void saveTag(group, tag)}
                        >
                          保存
                        </button>
                      </div>
                    ) : (
                      <div key={tag.id} className="flex items-center gap-0.5">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingTagId(tag.id);
                            setEditingTagName(tag.name);
                            setEditingTagColor(tag.color);
                          }}
                          className="rounded-md border border-subtle px-2 py-1 text-12 text-secondary hover:bg-surface-2"
                          title="点击编辑"
                        >
                          {tag.name}
                        </button>
                        <button
                          type="button"
                          className="text-11 text-tertiary hover:text-primary"
                          onClick={() => void moveTag(group, tag.id, -1)}
                          aria-label={`上移 ${tag.name}`}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="text-11 text-tertiary hover:text-primary"
                          onClick={() => void moveTag(group, tag.id, 1)}
                          aria-label={`下移 ${tag.name}`}
                        >
                          ↓
                        </button>
                      </div>
                    )
                  )}
                </div>
                {editingTagId && group.tags.some((tag) => tag.id === editingTagId) && (
                  <button
                    type="button"
                    className="mt-2 text-11 text-danger-primary hover:underline"
                    onClick={() => {
                      const tag = group.tags.find((value) => value.id === editingTagId);
                      if (tag) void deleteTag(group, tag);
                    }}
                  >
                    删除正在编辑的标签
                  </button>
                )}
                <div className="mt-4 flex items-center gap-2">
                  <input
                    className="h-8 w-52 rounded-md border border-subtle bg-surface-1 px-2 text-12"
                    value={draft.name}
                    onChange={(event) =>
                      setNewTag((current) => ({ ...current, [group.id]: { ...draft, name: event.target.value } }))
                    }
                    placeholder="新增标签"
                  />
                  <select
                    className="h-8 rounded-md border border-subtle bg-surface-1 px-2 text-12"
                    value={draft.color}
                    onChange={(event) =>
                      setNewTag((current) => ({
                        ...current,
                        [group.id]: { ...draft, color: event.target.value as IWorkspaceMemberTag["color"] },
                      }))
                    }
                  >
                    {COLOR_OPTIONS.map((color) => (
                      <option key={color} value={color}>
                        {color}
                      </option>
                    ))}
                  </select>
                  <Button variant="secondary" size="sm" onClick={() => void createTag(group)}>
                    添加标签
                  </Button>
                </div>
              </section>
            );
          })}
          {groups.length === 0 && <p className="py-12 text-center text-13 text-tertiary">还没有成员标签组。</p>}
        </div>
      </div>
    </SettingsContentWrapper>
  );
});

export default MemberTagsSettingsPage;
