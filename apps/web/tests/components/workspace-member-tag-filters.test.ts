import { expect, it } from "vitest";
import { sortWorkspaceMembers } from "@/store/member/utils";

const MEMBER_DETAILS = {
  "member-1": { id: "member-1", display_name: "Alice" },
  "member-2": { id: "member-2", display_name: "Bob" },
  "member-3": { id: "member-3", display_name: "Chris" },
};

/** 成员标签筛选按照任一匹配规则保留成员。 */
it("多个成员标签按任一标签匹配", () => {
  const members = [
    { id: "membership-1", member: "member-1", role: 15, tags: [{ id: "tag-grade" }] },
    { id: "membership-2", member: "member-2", role: 15, tags: [{ id: "tag-group" }] },
    { id: "membership-3", member: "member-3", role: 15, tags: [{ id: "tag-other" }] },
  ];

  const result = sortWorkspaceMembers(members, MEMBER_DETAILS, (member) => member.member, {
    tag_ids: ["tag-grade", "tag-group"],
  });

  expect(result.map((member) => member.member)).toEqual(["member-1", "member-2"]);
});
