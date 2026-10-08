import { describe, expect, it } from "vitest";

import { buildProjectListSearchParams } from "@/components/research/projects/research-project-list";
import { buildReportListSearchParams } from "@/components/research/reports/report-list";

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

describe("buildReportListSearchParams", () => {
  it("keeps the default report scope at all visible reports", () => {
    const params = buildReportListSearchParams(new URLSearchParams("view=reports&source=sw05"), {
      status: "",
      reportType: "",
      periodKey: "",
      mineOnly: false,
      orgUnit: "",
      owner: "",
      dateFrom: "",
      dateTo: "",
    });

    expect(params.get("view")).toBe("reports");
    expect(params.get("source")).toBe("sw05");
    expect(params.has("mine")).toBe(false);
  });

  it("serializes an explicit personal scope and preserves the other filters", () => {
    const params = buildReportListSearchParams(new URLSearchParams("tab=mine&mine=false"), {
      status: "SUBMITTED",
      reportType: "MONTHLY",
      periodKey: " 2026-10 ",
      mineOnly: true,
      orgUnit: "group-a",
      owner: " owner-a ",
      dateFrom: "2026-10-01",
      dateTo: "2026-10-31",
    });

    expect(params.get("tab")).toBe("mine");
    expect(params.get("mine")).toBe("true");
    expect(params.get("period_key")).toBe("2026-10");
    expect(params.get("owner")).toBe("owner-a");
  });
});
