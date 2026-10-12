// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IIssueFilters } from "@plane/types";

const mocks = vi.hoisted(() => ({
  project: {
    administrativeJoinedProjectIds: ["admin"],
    joinedProjectIds: ["admin", "research"],
    fetchStatus: "complete",
  },
  analytics: { selectedProjects: ["admin", "research", "deleted"], updateSelectedProjects: vi.fn() },
  selectProps: null as { projectIds: string[] } | null,
  filter: {
    allConditions: [
      { id: "project-condition", property: "project_id", value: ["admin", "research", "deleted"] },
      { id: "priority-condition", property: "priority", value: ["high"] },
    ],
    updateConditionValue: vi.fn(),
    configManager: { setAreConfigsReady: vi.fn(), registerAll: vi.fn() },
  },
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => mocks.project }));
vi.mock("@/hooks/store/use-analytics", () => ({ useAnalytics: () => mocks.analytics }));
vi.mock("../../core/components/analytics/select/project", () => ({
  ProjectSelect: (props: { projectIds: string[] }) => {
    mocks.selectProps = props;
    return null;
  },
}));
vi.mock("@/hooks/store/work-item-filters/use-work-item-filters", () => ({
  useWorkItemFilters: () => ({ getOrCreateFilter: () => mocks.filter, deleteFilter: vi.fn() }),
}));
vi.mock("@/hooks/work-item-filters/use-work-item-filters-config", () => ({
  useWorkItemFiltersConfig: () => ({ configs: [], areAllConfigsInitialized: true }),
}));

const { default: AnalyticsFilterActions } = await import("@/components/analytics/analytics-filter-actions");
const { WorkItemFiltersHOC } = await import("@/components/work-item-filters/filters-hoc/base");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.project.fetchStatus = "complete";
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("restricts analytics options and drops research and stale selections", async () => {
  await act(async () => root.render(<AnalyticsFilterActions />));
  expect(mocks.selectProps?.projectIds).toEqual(["admin"]);
  expect(mocks.analytics.updateSelectedProjects).toHaveBeenCalledWith(["admin"]);
});

it("waits for project loading before removing analytics selections", async () => {
  mocks.project.fetchStatus = "fetching";
  await act(async () => root.render(<AnalyticsFilterActions />));
  expect(mocks.analytics.updateSelectedProjects).not.toHaveBeenCalled();
});

it("prunes old workspace view selections while preserving other conditions", async () => {
  await act(async () =>
    root.render(
      <WorkItemFiltersHOC
        workspaceSlug="lab"
        entityType={"GLOBAL" as never}
        entityId="all-issues"
        filtersToShowByLayout={["project_id"]}
        projectIds={["admin"]}
        administrativeProjectScopeReady
        initialWorkItemFilters={{ richFilters: {} } as IIssueFilters}
        updateFilters={vi.fn()}
      >
        <span>view</span>
      </WorkItemFiltersHOC>
    )
  );
  expect(mocks.filter.updateConditionValue).toHaveBeenCalledExactlyOnceWith("project-condition", ["admin"]);
});
