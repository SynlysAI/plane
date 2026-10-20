// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { coreRoutes } from "../../app/routes/core";

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ getPartialProjectById: () => ({ id: "project" }) }),
}));
vi.mock("@/hooks/store/user", () => ({ useUserPermissions: () => ({ allowPermissions: () => true }) }));
vi.mock("@/components/navigation/project-header", () => ({ ProjectHeader: () => <span>当前项目</span> }));
vi.mock("@/components/navigation/use-navigation-items", () => ({
  useNavigationItems: () => [
    { key: "work_items", href: "/lab/projects/project/issues" },
    { key: "approvals", href: "/lab/projects/project/approvals" },
  ],
}));
const { TabNavigationRoot } = await import("@/components/navigation/tab-navigation-root");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

type ConfigRoute = { file?: string; path?: string; children?: ConfigRoute[] };
function routeAncestors(entries: ConfigRoute[], path: string, parents: string[] = []): string[] | undefined {
  for (const entry of entries) {
    if (entry.path === path) return parents;
    const found = routeAncestors(entry.children ?? [], path, entry.file ? [...parents, entry.file] : parents);
    if (found) return found;
  }
  return undefined;
}
it.each(["issues", "issues/:archivedIssueId", "cycles", "modules"])(
  "keeps archives/%s inside the shared project layout",
  (path) => {
    const ancestors = routeAncestors(coreRoutes, `:workspaceSlug/projects/:projectId/archives/${path}`);
    expect(ancestors).toContain("./(all)/[workspaceSlug]/(projects)/projects/(detail)/[projectId]/layout.tsx");
  }
);
it.each(["issues", "issues/archived-item", "cycles", "modules"])(
  "marks the archive tab selected on archives/%s",
  async (path) => {
    await act(async () =>
      root.render(
        <MemoryRouter initialEntries={[`/lab/projects/project/archives/${path}`]}>
          <TabNavigationRoot workspaceSlug="lab" projectId="project" />
        </MemoryRouter>
      )
    );
    const archive = [...container.querySelectorAll("a")].find((link) => link.textContent === "归档");
    expect(archive?.getAttribute("aria-current")).toBe("page");
    expect(archive?.className).toContain("border-accent-strong");
  }
);
it("switches between tasks and archives while preserving the project navigation", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/projects/project/issues"]}>
        <TabNavigationRoot workspaceSlug="lab" projectId="project" />
        <Routes>
          <Route path="/lab/projects/project/issues" element={<p>任务内容</p>} />
          <Route path="/lab/projects/project/archives/issues" element={<p>归档内容</p>} />
        </Routes>
      </MemoryRouter>
    )
  );
  await act(async () => [...container.querySelectorAll("a")].find((link) => link.textContent === "归档")?.click());
  expect(container.textContent).toContain("归档内容");
  expect(container.querySelector('[aria-label="项目功能"]')).not.toBeNull();
  await act(async () => [...container.querySelectorAll("a")].find((link) => link.textContent === "任务")?.click());
  expect(container.textContent).toContain("任务内容");
});
