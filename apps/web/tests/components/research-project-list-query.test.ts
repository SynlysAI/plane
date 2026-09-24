import { describe, expect, it } from "vitest";

import { buildProjectListSearchParams } from "@/components/research/projects/research-project-list";

describe("buildProjectListSearchParams", () => {
  it("preserves unknown legacy query values while updating project filters", () => {
    const current = new URLSearchParams("source=sw05&owner=previous&view=projects#ignored");
    const params = buildProjectListSearchParams(current, {
      view: "projects",
      workflowStatus: "ACTIVE",
      researchType: "",
      orgUnit: "",
      owner: "next-owner",
      dateFrom: "",
      dateTo: "",
    });

    expect(params.get("source")).toBe("sw05");
    expect(params.get("view")).toBe("projects");
    expect(params.get("workflow_status")).toBe("ACTIVE");
    expect(params.get("owner")).toBe("next-owner");
    expect(params.has("research_type")).toBe(false);
  });
});
