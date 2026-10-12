import { describe, expect, it } from "vitest";

import { RESEARCH_IA_V2_NAVIGATION_ITEMS, WORKSPACE_SIDEBAR_STATIC_NAVIGATION_ITEMS_LINKS } from "@plane/constants";
import { coreRoutes } from "../../app/routes/core";

type FlatRoute = {
  path?: string;
  file?: string;
  children?: FlatRoute[];
};

/**递归展开路由配置，供 IA 基线断言使用。*/
function flattenRoutes(routes: FlatRoute[]): FlatRoute[] {
  return routes.flatMap((entry) => [entry, ...flattenRoutes(entry.children ?? [])]);
}

describe("research IA baseline", () => {
  it("keeps the workspace home as the only home destination when IA v2 is enabled", () => {
    const workspaceHomeItems = WORKSPACE_SIDEBAR_STATIC_NAVIGATION_ITEMS_LINKS.filter((item) => item.key === "home");

    expect(workspaceHomeItems).toHaveLength(1);
    expect(workspaceHomeItems[0]?.href).toBe("/");
    const iaV2Paths: string[] = RESEARCH_IA_V2_NAVIGATION_ITEMS.map((item) => item.path);
    expect(iaV2Paths).not.toContain("");
  });

  it("keeps research and administrative destinations distinct", () => {
    const destinations = [
      "/",
      ...RESEARCH_IA_V2_NAVIGATION_ITEMS.map((item) => `/research/${item.path}`),
      "/projects/",
    ];

    expect(RESEARCH_IA_V2_NAVIGATION_ITEMS.map((item) => item.key)).toContain("research_chain");
    expect(destinations).toEqual([...new Set(destinations)]);
  });

  it("registers every legacy research route needed by the IA v2 rollback path", () => {
    const routes = flattenRoutes(coreRoutes);
    const paths = new Set(routes.map((route) => route.path));
    const legacyPaths = [
      ":workspaceSlug/research",
      ":workspaceSlug/research/reports",
      ":workspaceSlug/research/reports/summary",
      ":workspaceSlug/research/projects",
      ":workspaceSlug/research/chains",
      ":workspaceSlug/research/reviews",
      ":workspaceSlug/research/approvals",
      ":workspaceSlug/research/audit",
      ":workspaceSlug/research/integrations",
    ];

    legacyPaths.forEach((path) => expect(paths.has(path)).toBe(true));
  });

  it("registers every ordinary Plane route reused by the administrative container", () => {
    const routes = flattenRoutes(coreRoutes);
    const paths = new Set(routes.map((route) => route.path));
    const ordinaryPlanePaths = [
      ":workspaceSlug/projects",
      ":workspaceSlug/workspace-views",
      ":workspaceSlug/workspace-views/:globalViewId",
      ":workspaceSlug/analytics/:tabId",
      ":workspaceSlug/analytics",
      ":workspaceSlug/projects/archives",
    ];

    ordinaryPlanePaths.forEach((path) => expect(paths.has(path)).toBe(true));
  });
});
