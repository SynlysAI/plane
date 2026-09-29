import { expect, it } from "vitest";
import { projectIsVisibleInSidebar } from "@/store/project/project-visibility";

it("shows a research review project without inventing a member role", () => {
  expect(
    projectIsVisibleInSidebar(
      { workspace: "public", member_role: null, research_access: "review", archived_at: null },
      "public"
    )
  ).toBe(true);
  expect(
    projectIsVisibleInSidebar(
      { workspace: "public", member_role: 20, research_access: null, archived_at: null },
      "public"
    )
  ).toBe(true);
  expect(
    projectIsVisibleInSidebar(
      { workspace: "public", member_role: null, research_access: null, archived_at: null },
      "public"
    )
  ).toBe(false);
  expect(
    projectIsVisibleInSidebar(
      { workspace: "public", member_role: null, research_access: "review", archived_at: "2026-09-27" },
      "public"
    )
  ).toBe(false);
});
