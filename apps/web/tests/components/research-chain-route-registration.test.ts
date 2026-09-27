import { describe, expect, it } from "vitest";

import { coreRoutes } from "../../app/routes/core";

type FlatRoute = {
  path?: string;
  file?: string;
  children?: FlatRoute[];
};

/**递归展开 React Router 配置，便于断言任意层级的路由注册。*/
function flattenRoutes(routes: FlatRoute[]): FlatRoute[] {
  return routes.flatMap((entry) => [entry, ...flattenRoutes(entry.children ?? [])]);
}

describe("research chain route registration", () => {
  it("registers the chain board, detail, and node agent pages", () => {
    const routes = flattenRoutes(coreRoutes);

    expect(routes).toContainEqual({
      path: ":workspaceSlug/research/chains",
      file: "./(all)/[workspaceSlug]/(projects)/research/chains/page.tsx",
    });
    expect(routes).toContainEqual({
      path: ":workspaceSlug/research/chains/:chainId",
      file: "./(all)/[workspaceSlug]/(projects)/research/chains/[chainId]/page.tsx",
    });
    expect(routes).toContainEqual({
      path: ":workspaceSlug/research/chains/:chainId/nodes/:nodeId/agent",
      file: "./(all)/[workspaceSlug]/(projects)/research/chains/[chainId]/nodes/[nodeId]/agent/page.tsx",
    });
  });

  it("registers the IA v2 management destination and aggregated audit and integration tabs", () => {
    const routes = flattenRoutes(coreRoutes);

    expect(routes).toContainEqual({
      path: ":workspaceSlug/research/settings",
      file: "./(all)/[workspaceSlug]/(projects)/research/settings/page.tsx",
    });
    expect(routes).toContainEqual({
      path: ":workspaceSlug/research/settings/audit",
      file: "./(all)/[workspaceSlug]/(projects)/research/settings/audit/page.tsx",
    });
    expect(routes).toContainEqual({
      path: ":workspaceSlug/research/settings/integrations",
      file: "./(all)/[workspaceSlug]/(projects)/research/settings/integrations/page.tsx",
    });
  });
});
