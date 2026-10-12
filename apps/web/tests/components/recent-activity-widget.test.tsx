// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig, type Cache } from "swr";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TActivityEntityData } from "@plane/types";
import { WorkspaceService } from "@/services/workspace.service";

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/home/widgets/empty-states", () => ({ RecentsEmptyState: () => <p>暂无访问</p> }));
vi.mock("@/components/home/widgets/loaders", () => ({
  EWidgetKeys: { RECENT_ACTIVITY: "recents" },
  WidgetLoader: () => <div>加载中</div>,
}));
vi.mock("@/components/home/widgets/recents/project", () => ({
  RecentProject: ({ activity }: { activity: TActivityEntityData }) => <p>{activity.entity_data.name}</p>,
}));
vi.mock("@/components/home/widgets/recents/page", () => ({ RecentPage: () => null }));
vi.mock("@/components/home/widgets/recents/issue", () => ({ RecentIssue: () => null }));

const { RecentActivityWidget } = await import("@/components/home/widgets/recents");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let cache: Cache;
const originalFetchRecents = WorkspaceService.prototype.fetchWorkspaceRecents;
const fetchRecents = vi.spyOn(WorkspaceService.prototype, "fetchWorkspaceRecents");

/** 创建具有有效数据的最近项目访问记录。 */
function recent(name: string): TActivityEntityData {
  return {
    id: name,
    entity_name: "project",
    entity_identifier: name,
    visited_at: "2026-10-12T08:00:00Z",
    entity_data: { id: name, name, identifier: "ADM", project_members: [], logo_props: {} } as never,
  };
}

/** 在隔离缓存中渲染访问组件，支持范围和刷新序号变更。 */
async function renderRecents(scope?: "administrative", refreshToken = 0) {
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>
        <RecentActivityWidget workspaceSlug="lab" embedded scope={scope} refreshToken={refreshToken} />
      </SWRConfig>
    )
  );
  await act(async () => undefined);
}

beforeEach(() => {
  cache = new Map();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  fetchRecents.mockResolvedValue([recent("行政项目")]);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetchRecents.mockReset();
});

it("requests scoped recents and revalidates on home refresh", async () => {
  await renderRecents("administrative");
  expect(fetchRecents).toHaveBeenCalledWith("lab", undefined, "administrative");
  fetchRecents.mockResolvedValue([recent("刷新后的行政项目")]);
  await renderRecents("administrative", 1);
  expect(fetchRecents).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("刷新后的行政项目");
});

it("isolates the administrative cache from generic recents", async () => {
  fetchRecents.mockResolvedValue([recent("通用科研项目")]);
  await renderRecents();
  expect(container.textContent).toContain("通用科研项目");
  fetchRecents.mockResolvedValue([recent("行政项目")]);
  await renderRecents("administrative");
  expect(container.textContent).toContain("行政项目");
  expect(container.textContent).not.toContain("通用科研项目");
  expect(fetchRecents).toHaveBeenCalledTimes(2);
});

it("renders the empty state for missing entities", async () => {
  fetchRecents.mockResolvedValue([{ ...recent("已删除"), entity_data: null } as never]);
  await renderRecents("administrative");
  expect(container.textContent).toContain("暂无访问");
});

it("reports request failures instead of presenting an empty list", async () => {
  fetchRecents.mockRejectedValue(new Error("unavailable"));
  await renderRecents("administrative");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("recent_error");
});

it("passes the optional scope through the service without changing response data", async () => {
  const service = new WorkspaceService();
  const response = [recent("行政项目")];
  const get = vi.spyOn(service, "get").mockResolvedValue({ data: response } as never);
  expect(await originalFetchRecents.call(service, "lab", "project", "administrative")).toEqual(response);
  expect(get).toHaveBeenCalledWith("/api/workspaces/lab/recent-visits/", {
    params: { entity_name: "project", scope: "administrative" },
  });
  get.mockRestore();
});
