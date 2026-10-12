import { expect, it, vi } from "vitest";
import type { TProject } from "@plane/types";
import { ProjectStore } from "@/store/project/project.store";
import type { CoreRootStore } from "@/store/root.store";
import { ProjectService } from "@/services/project/project.service";

/** 创建混合缓存，验证行政派生集合不会破坏科研链缓存。 */
function createStore() {
  const root = {
    workspaceRoot: {
      currentWorkspace: { id: "workspace" },
      getWorkspaceBySlug: () => ({ id: "workspace" }),
    },
    user: { permission: { workspaceProjectsPermissions: {}, projectUserInfo: {} } },
    projectRoot: {
      projectFilter: {
        currentWorkspaceDisplayFilters: { order_by: "name" },
        currentWorkspaceFilters: {},
        searchQuery: "",
      },
    },
  } as unknown as CoreRootStore;
  const store = new ProjectStore(root);
  store.projectMap = Object.fromEntries(
    [
      { id: "admin", is_research_project: false },
      { id: "archived", is_research_project: false, archived_at: "2026-01-01" },
      { id: "research", is_research_project: true },
      { id: "unknown" },
      { id: "other", is_research_project: false, workspace: "another" },
    ].map((project) => [
      project.id,
      { name: project.id, identifier: project.id, workspace: "workspace", member_role: 20, ...project },
    ])
  ) as unknown as Record<string, TProject>;
  return store;
}

it("derives administrative lists and selectors from a shared mixed cache", () => {
  const store = createStore();
  expect(store.administrativeProjectIds).toEqual(["admin", "archived"]);
  expect(store.administrativeFilteredProjectIds).toEqual(["admin"]);
  expect(store.administrativeJoinedProjectIds).toEqual(["admin"]);
  expect(store.projectMap.research).toBeDefined();
});

it("requests administrative scope and retains shared research data", async () => {
  const store = createStore();
  const mock = vi.spyOn(ProjectService.prototype, "getProjects").mockResolvedValue([store.projectMap.admin]);
  try {
    await store.fetchProjects("lab", "administrative");
    expect(mock).toHaveBeenCalledWith("lab", "administrative");
    expect(store.projectMap.research).toBeDefined();
    expect(store.administrativeProjectIds).toEqual(["admin"]);
  } finally {
    mock.mockRestore();
  }
});
