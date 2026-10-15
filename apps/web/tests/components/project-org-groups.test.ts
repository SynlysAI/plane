import { describe, expect, it } from "vitest";
import type { TProject } from "@plane/types";

import { UNGROUPED_ORGANIZATION_NAME, groupProjectsByOrganization } from "@/components/project/project-org-groups";

const organizations = [
  { id: "org-12dc", name: "12dc", is_default: false },
  { id: "org-public", name: "公共", is_default: true },
  { id: "org-test2", name: "test2", is_default: false },
];

function project(id: string, organizationId: string | null): TProject {
  return { id, name: id, administrative_organization: organizationId } as TProject;
}

const projects: Record<string, TProject> = {
  "public-1": project("public-1", "org-public"),
  "public-2": project("public-2", "org-public"),
  "12dc-1": project("12dc-1", "org-12dc"),
  "test2-1": project("test2-1", "org-test2"),
  "hidden-1": project("hidden-1", "org-invisible"),
  "legacy-1": project("legacy-1", null),
};

const getProjectById = (id: string) => projects[id];

describe("groupProjectsByOrganization", () => {
  it("orders the default organization first, others by name, and ungrouped last", () => {
    const groups = groupProjectsByOrganization(
      ["12dc-1", "legacy-1", "public-1", "test2-1", "public-2", "hidden-1"],
      getProjectById,
      organizations
    );

    expect(groups.map((group) => group.name)).toEqual(["公共", "12dc", "test2", UNGROUPED_ORGANIZATION_NAME]);
    expect(groups.map((group) => group.projectIds)).toEqual([
      ["public-1", "public-2"],
      ["12dc-1"],
      ["test2-1"],
      ["legacy-1", "hidden-1"],
    ]);
  });

  it("drops empty organizations", () => {
    const groups = groupProjectsByOrganization(["test2-1"], getProjectById, organizations);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual({ id: "org-test2", name: "test2", projectIds: ["test2-1"] });
  });

  it("returns no groups for an empty project list", () => {
    expect(groupProjectsByOrganization([], getProjectById, organizations)).toEqual([]);
  });
});
