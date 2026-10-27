import { describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => ({
  bulkAddMembersToProject: vi.fn(),
  fetchProjectMembers: vi.fn(),
}));

vi.mock("@/services/project", () => ({
  ProjectMemberService: class {
    bulkAddMembersToProject = serviceMocks.bulkAddMembersToProject;
    fetchProjectMembers = serviceMocks.fetchProjectMembers;
  },
  ProjectService: class {
    readonly unused = false;
  },
}));

import { BaseProjectMemberStore } from "@/store/member/project/base-project-member.store";
import type { RootStore } from "@/store/root.store";
import type { IMemberRootStore } from "@/store/member";

/** 创建带可控服务和项目缓存的成员 store。 */
function createStore(projectMap: Record<string, { members?: string[] }>) {
  const rootStore = {
    router: {},
    user: {},
    projectRoot: { project: { projectMap } },
  } as unknown as RootStore;
  const store = new BaseProjectMemberStore({} as IMemberRootStore, rootStore);
  return store;
}

describe("BaseProjectMemberStore bulkAddMembersToProject", () => {
  it("项目缓存没有 members 时也能安全合并新增成员", async () => {
    const store = createStore({ project: {} });
    serviceMocks.bulkAddMembersToProject.mockResolvedValueOnce([
      { id: "membership-a", member: "user-a", role: 15 },
      { id: "membership-b", member: "user-b", role: 15 },
    ]);

    await expect(
      store.bulkAddMembersToProject("workspace", "project", {
        members: [
          { member_id: "user-a", role: 15 },
          { member_id: "user-b", role: 15 },
        ],
      })
    ).resolves.toHaveLength(2);

    expect(store.projectRoot.projectMap.project.members).toEqual(["user-a", "user-b"]);
  });

  it("重复提交同批成员时保留去重后的项目成员 ID", async () => {
    const store = createStore({ project: { members: ["user-a"] } });
    serviceMocks.bulkAddMembersToProject.mockResolvedValueOnce([
      { id: "membership-a", member: "user-a", role: 15 },
      { id: "membership-b", member: "user-b", role: 15 },
    ]);

    await store.bulkAddMembersToProject("workspace", "project", {
      members: [
        { member_id: "user-a", role: 15 },
        { member_id: "user-b", role: 15 },
      ],
    });

    expect(store.projectRoot.projectMap.project.members).toEqual(["user-a", "user-b"]);
  });

  it("成员列表刷新失败不会把服务端成功添加误报为失败", async () => {
    const store = createStore({ project: {} });
    const response = [{ id: "membership-a", member: "user-a", role: 15 }];
    serviceMocks.bulkAddMembersToProject.mockResolvedValueOnce(response);
    serviceMocks.fetchProjectMembers.mockRejectedValueOnce(new Error("refresh failed"));

    await expect(
      store.bulkAddMembersToProject("workspace", "project", {
        members: [{ member_id: "user-a", role: 15 }],
      })
    ).resolves.toBe(response);

    expect(store.projectMemberMap.project["user-a"]).toMatchObject({ member: "user-a", original_role: 15 });
  });
});
