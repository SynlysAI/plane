import { afterEach, expect, it, vi } from "vitest";
import type { IUserLite, TProjectMembership } from "@plane/types";
import { ProjectMemberStore } from "@/store/member/project/base-project-member.store";
import type { IMemberRootStore } from "@/store/member";
import type { RootStore } from "@/store/root.store";
import { ProjectMemberService } from "@/services/project";

const inherited: TProjectMembership = {
  id: null,
  member: "inherited",
  role: 15,
  original_role: null,
  created_at: null,
  membership_source: "ORGANIZATION",
  inherits_organization: true,
};
const direct: TProjectMembership = {
  id: "direct-grant",
  member: "direct",
  role: 15,
  original_role: 15,
  created_at: "2026-10-20",
  membership_source: "DIRECT",
  inherits_organization: false,
};

function createStore() {
  const members = {
    memberMap: {
      inherited: { id: "inherited", display_name: "Organization colleague" } as IUserLite,
      direct: { id: "direct", display_name: "Invited colleague" } as IUserLite,
    },
  } as IMemberRootStore;
  const root = {
    router: { projectId: "project" },
    user: { data: { id: "current" } },
    projectRoot: { project: { projectMap: { project: { members: ["inherited", "direct"] } } } },
  } as unknown as RootStore;
  return new ProjectMemberStore(members, root);
}

afterEach(() => vi.restoreAllMocks());

it("exposes inherited members as assignees and preserves their source in settings", async () => {
  vi.spyOn(ProjectMemberService.prototype, "fetchProjectMembers").mockResolvedValue([inherited, direct]);
  const store = createStore();
  await store.fetchProjectMembers("lab", "project");
  expect(new Set(store.getProjectMemberIds("project", false))).toEqual(new Set(["inherited", "direct"]));
  expect(store.getFilteredProjectMemberDetails("inherited", "project")).toMatchObject({
    id: null,
    role: 15,
    original_role: null,
    membership_source: "ORGANIZATION",
    inherits_organization: true,
  });
});

it("removes revoked inheritance from a cached roster while preserving direct members", async () => {
  const fetch = vi
    .spyOn(ProjectMemberService.prototype, "fetchProjectMembers")
    .mockResolvedValueOnce([inherited, direct])
    .mockResolvedValueOnce([direct]);
  const store = createStore();
  await store.fetchProjectMembers("lab", "project");
  await store.fetchProjectMembers("lab", "project");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(store.getProjectMemberIds("project", false)).toEqual(["direct"]);
  expect(store.getProjectMemberDetails("inherited", "project")).toBeNull();
});

it("removing a separate grant restores inherited participation instead of dropping the member", async () => {
  const both: TProjectMembership = {
    id: "extra-grant",
    member: "inherited",
    role: 20,
    original_role: 20,
    created_at: "2026-10-20",
    membership_source: "DIRECT",
    inherits_organization: true,
  };
  vi.spyOn(ProjectMemberService.prototype, "fetchProjectMembers")
    .mockResolvedValueOnce([both, direct])
    .mockResolvedValueOnce([inherited, direct]);
  const remove = vi.spyOn(ProjectMemberService.prototype, "deleteProjectMember").mockResolvedValue(undefined);
  const store = createStore();
  await store.fetchProjectMembers("lab", "project");
  await store.removeMemberFromProject("lab", "project", "inherited");
  expect(remove).toHaveBeenCalledWith("lab", "project", "extra-grant");
  expect(store.getProjectMemberDetails("inherited", "project")).toMatchObject({ id: null, role: 15 });
});
