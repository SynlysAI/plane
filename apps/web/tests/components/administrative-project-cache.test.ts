import { expect, it, vi } from "vitest";
import type { TProject } from "@plane/types";
import { ProjectStore } from "@/store/project/project.store";
import type { CoreRootStore } from "@/store/root.store";
import { ProjectService } from "@/services/project/project.service";

/** 创建带旧项目权限的独立缓存，包含科研项目和另一工作区项目。 */
function createStore() {
  const permission = {
    workspaceProjectsPermissions: { lab: { hidden: 15, visible: 20 } },
    projectUserInfo: { lab: { hidden: { role: 15 }, visible: { role: 20 } } },
  };
  const root = {
    workspaceRoot: {
      currentWorkspace: { id: "workspace-1" },
      getWorkspaceBySlug: () => ({ id: "workspace-1" }),
    },
    user: { permission },
  } as unknown as CoreRootStore;
  const store = new ProjectStore(root);
  store.projectMap = {
    hidden: { id: "hidden", workspace: "workspace-1", is_research_project: false, member_role: 15 },
    visible: { id: "visible", workspace: "workspace-1", is_research_project: false, member_role: 20 },
    research: { id: "research", workspace: "workspace-1", is_research_project: true },
    other: { id: "other", workspace: "workspace-2", is_research_project: false },
  } as unknown as Record<string, TProject>;
  return { store, permission };
}

it.each(["fetchProjects", "fetchPartialProjects"] as const)(
  "%s removes revoked administrative access without clearing research or another workspace",
  async (method) => {
    const { store, permission } = createStore();
    const serviceMethod = method === "fetchProjects" ? "getProjects" : "getProjectsLite";
    const mock = vi.spyOn(ProjectService.prototype, serviceMethod).mockResolvedValue([store.projectMap.visible]);
    try {
      await store[method]("lab");
      expect(new Set(Object.keys(store.projectMap))).toEqual(new Set(["other", "research", "visible"]));
      expect(permission.workspaceProjectsPermissions.lab).toEqual({ visible: 20 });
      expect(permission.projectUserInfo.lab).toEqual({ visible: { role: 20 } });
    } finally {
      mock.mockRestore();
    }
  }
);

it("clears cached administrative roles when the detail endpoint rejects membership", async () => {
  const { store, permission } = createStore();
  const rejection = { status: 403, data: { code: "PROJECT_MEMBERSHIP_REQUIRED" } };
  const mock = vi.spyOn(ProjectService.prototype, "getProject").mockRejectedValue(rejection);
  try {
    await expect(store.fetchProjectDetails("lab", "hidden")).rejects.toEqual(rejection);
    expect(store.projectMap.hidden).toBeUndefined();
    expect(permission.workspaceProjectsPermissions.lab).toEqual({ visible: 20 });
    expect(permission.projectUserInfo.lab).toEqual({ visible: { role: 20 } });
  } finally {
    mock.mockRestore();
  }
});

it("keeps cached content on a temporary server error", async () => {
  const { store, permission } = createStore();
  const rejection = { status: 500, data: {} };
  const mock = vi.spyOn(ProjectService.prototype, "getProject").mockRejectedValue(rejection);
  try {
    await expect(store.fetchProjectDetails("lab", "hidden")).rejects.toEqual(rejection);
    expect(store.projectMap.hidden).toBeDefined();
    expect(permission.workspaceProjectsPermissions.lab.hidden).toBe(15);
  } finally {
    mock.mockRestore();
  }
});
