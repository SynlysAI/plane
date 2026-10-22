import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { coreRoutes } from "../../app/routes/core";

type ConfigRoute = { file?: string; path?: string; children?: ConfigRoute[] };

const DETAIL_PARENTS: Array<{
  detailPath: string;
  parentPath: string;
  headerFile: string;
  parentHref: string;
  label: string;
}> = [
  {
    detailPath: ":workspaceSlug/browse/:workItem",
    parentPath: ":workspaceSlug/projects/:projectId/issues",
    headerFile: "app/(all)/[workspaceSlug]/(projects)/browse/[workItem]/work-item-header.tsx",
    parentHref: "/${workspaceSlug}/projects/${projectId}/issues/",
    label: "返回工作项列表",
  },
  {
    detailPath: ":workspaceSlug/projects/:projectId/cycles/:cycleId",
    parentPath: ":workspaceSlug/projects/:projectId/cycles",
    headerFile: "app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/cycles/(detail)/header.tsx",
    parentHref: "/${workspaceSlug}/projects/${projectId}/cycles/",
    label: "返回周期列表",
  },
  {
    detailPath: ":workspaceSlug/projects/:projectId/modules/:moduleId",
    parentPath: ":workspaceSlug/projects/:projectId/modules",
    headerFile: "app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/modules/(detail)/header.tsx",
    parentHref: "/${workspaceSlug}/projects/${projectId}/modules/",
    label: "返回模块列表",
  },
  {
    detailPath: ":workspaceSlug/projects/:projectId/views/:viewId",
    parentPath: ":workspaceSlug/projects/:projectId/views",
    headerFile: "app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/views/(detail)/[viewId]/header.tsx",
    parentHref: "/${workspaceSlug}/projects/${projectId}/views/",
    label: "返回视图列表",
  },
  {
    detailPath: ":workspaceSlug/projects/:projectId/pages/:pageId",
    parentPath: ":workspaceSlug/projects/:projectId/pages",
    headerFile: "app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/pages/(detail)/header.tsx",
    parentHref: "/${workspaceSlug}/projects/${projectId}/pages/",
    label: "返回页面列表",
  },
  {
    detailPath: ":workspaceSlug/projects/:projectId/archives/issues/:archivedIssueId",
    parentPath: ":workspaceSlug/projects/:projectId/archives/issues",
    headerFile:
      "app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/archives/issues/(detail)/header.tsx",
    parentHref: "/${workspaceSlug}/projects/${projectId}/archives/issues/",
    label: "返回归档工作项",
  },
  {
    detailPath: ":workspaceSlug/workspace-views/:globalViewId",
    parentPath: ":workspaceSlug/workspace-views",
    headerFile: "app/(all)/[workspaceSlug]/(projects)/workspace-views/header.tsx",
    parentHref: "/${workspaceSlug}/workspace-views",
    label: "返回工作区视图列表",
  },
  {
    detailPath: ":workspaceSlug/settings/webhooks/:webhookId",
    parentPath: ":workspaceSlug/settings/webhooks",
    headerFile: "app/(all)/[workspaceSlug]/(settings)/settings/(workspace)/webhooks/[webhookId]/header.tsx",
    parentHref: "/${workspaceSlug}/settings/webhooks",
    label: "返回 Webhook 列表",
  },
  {
    detailPath: ":workspaceSlug/settings/projects/:projectId",
    parentPath: ":workspaceSlug/settings/projects",
    headerFile: "app/(all)/[workspaceSlug]/(settings)/settings/projects/[projectId]/header.tsx",
    parentHref: "/${workspaceSlug}/settings/projects",
    label: "返回项目设置列表",
  },
];

/** 功能禁用空态的“启用功能”按钮必须指向对应 feature 设置子路由。 */
const FEATURE_EMPTY_STATES: Array<{ feature: string; pageFile: string }> = [
  {
    feature: "cycles",
    pageFile: "app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/cycles/(list)/page.tsx",
  },
  {
    feature: "modules",
    pageFile: "app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/modules/(list)/page.tsx",
  },
  {
    feature: "pages",
    pageFile: "app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/pages/(list)/page.tsx",
  },
  {
    feature: "views",
    pageFile: "app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/views/(list)/page.tsx",
  },
  {
    feature: "intake",
    pageFile: "app/(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/intake/page.tsx",
  },
];

/** 递归收集 React Router 配置中的全部路由路径。 */
function collectRoutePaths(routes: ConfigRoute[]): string[] {
  return routes.flatMap((route) => [...(route.path ? [route.path] : []), ...collectRoutePaths(route.children ?? [])]);
}

it("keeps every detail route anchored to its fixed parent route", () => {
  const routePaths = new Set(collectRoutePaths(coreRoutes));

  for (const expected of DETAIL_PARENTS) {
    expect(routePaths, expected.detailPath).toContain(expected.detailPath);
    expect(routePaths, expected.parentPath).toContain(expected.parentPath);
  }
});

it("renders a fixed-parent back link before breadcrumbs on every traditional detail header", () => {
  const webRoot = path.resolve(__dirname, "../..");

  for (const expected of DETAIL_PARENTS) {
    const source = readFileSync(path.join(webRoot, expected.headerFile), "utf8");
    const match = source.match(/<DetailBackLink href=\{`([^`]+)`\}>([^<]+)<\/DetailBackLink>/);
    expect(match, expected.headerFile).not.toBeNull();
    expect(match?.[1], expected.headerFile).toBe(expected.parentHref);
    expect(match?.[2]?.trim(), expected.headerFile).toBe(expected.label);
    expect(source.indexOf("<DetailBackLink"), expected.headerFile).toBeLessThan(source.indexOf("<Breadcrumbs"));
    expect(source, expected.headerFile).not.toContain("onBack={router.back}");
    expect(source, expected.headerFile).not.toContain("router.back()");
  }
});

it("points every disabled-feature empty state at its feature settings route", () => {
  const webRoot = path.resolve(__dirname, "../..");
  const routePaths = new Set(collectRoutePaths(coreRoutes));

  for (const expected of FEATURE_EMPTY_STATES) {
    const featureRoute = `:workspaceSlug/settings/projects/:projectId/features/${expected.feature}`;
    expect(routePaths, featureRoute).toContain(featureRoute);

    const source = readFileSync(path.join(webRoot, expected.pageFile), "utf8");
    expect(source, expected.pageFile).toContain(
      `\${workspaceSlug}/settings/projects/\${projectId}/features/${expected.feature}`
    );
    expect(source, expected.pageFile).not.toContain("`/${workspaceSlug}/settings/projects/${projectId}/features`");
  }
});
