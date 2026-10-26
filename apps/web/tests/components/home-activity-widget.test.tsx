// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  fetchWorkspaceActivities: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const literal = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      const text = typeof literal === "string" ? literal : key;
      if (!values) return text;
      return Object.entries(values).reduce(
        (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
        text
      );
    },
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@/services/workspace.service", () => ({
  WorkspaceService: class {
    fetchWorkspaceActivities = mocks.fetchWorkspaceActivities;
  },
}));

const { HomeActivityWidget } = await import("@/components/home/widgets/activity");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let cache: Map<string, unknown>;
let intersectionObservers: MockIntersectionObserver[] = [];

class MockIntersectionObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {
    intersectionObservers.push(this);
  }

  readonly root: Document | Element | null = null;
  readonly rootMargin: string = "0px";
  readonly thresholds: readonly number[] = [];

  observe = (target: Element) => {
    this.targets.add(target);
  };

  unobserve = (target: Element) => {
    this.targets.delete(target);
  };

  disconnect = () => {
    this.targets.clear();
  };

  takeRecords = () => [];

  dispatch(target: Element, isIntersecting: boolean) {
    if (!this.targets.has(target)) return;
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

function activity(id: string, occurredAt: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source: "project",
    actor: { id: "user-1", display_name: "学生一" },
    action: "updated",
    entity_type: "project",
    entity_id: "project-1",
    entity_name: "设备采购协作",
    project: { id: "project-1", name: "设备采购协作", identifier: "PROC" },
    url: "/lab/projects/project-1/issues",
    occurred_at: occurredAt,
    changes: [],
    summary: "",
    ...overrides,
  };
}

/** Construct a cursor-mode activity page response for component tests. */
function activityResponse(results: ReturnType<typeof activity>[], nextCursor: string | null = null) {
  return {
    results,
    next_cursor: nextCursor,
    has_more: Boolean(nextCursor),
    per_page: 12,
  };
}

async function renderWidget() {
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>
        <MemoryRouter initialEntries={["/lab"]}>
          <HomeActivityWidget workspaceSlug="lab" density="compact" refreshToken={0} />
        </MemoryRouter>
      </SWRConfig>
    )
  );
  await act(async () => undefined);
}

/** 模拟自动分页哨兵进入或离开视口。 */
async function dispatchIntersection(target: Element, isIntersecting = true) {
  await act(async () => {
    for (const observer of intersectionObservers) observer.dispatch(target, isIntersecting);
  });
}

beforeEach(() => {
  cache = new Map();
  intersectionObservers = [];
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

it("renders actor, object, link, timestamp and grouped real mutations", async () => {
  const now = new Date("2026-10-22T10:00:00Z");
  mocks.fetchWorkspaceActivities.mockResolvedValue(
    activityResponse([
      activity("event-2", "2026-10-22T09:56:00Z", {
        changes: [{ field: "name", old_value: "旧名称", new_value: "设备采购协作" }],
      }),
      activity("event-1", "2026-10-22T09:52:00Z", {
        changes: [{ field: "name", old_value: "旧名称", new_value: "设备采购协作" }],
      }),
      activity("report-1", "2026-10-22T08:00:00Z", {
        id: "report-1",
        source: "research",
        action: "report.submit",
        entity_type: "report",
        entity_id: "report-1",
        entity_name: "WEEKLY 2026-W42",
        url: "/lab/research/reports/report-1",
      }),
    ])
  );
  vi.setSystemTime(now);

  await renderWidget();

  expect(mocks.fetchWorkspaceActivities).toHaveBeenCalledWith("lab", {
    days: "30",
    pagination: "cursor",
    per_page: 12,
  });
  expect(container.textContent).toContain("学生一");
  expect(container.textContent).toContain("更新了设备采购协作");
  expect(container.textContent).toContain("提交了WEEKLY 2026-W42");
  expect(container.textContent).toContain("合并 2 次同类更新");
  expect(container.querySelector('a[href*="/lab/projects/project-1/issues"]')).not.toBeNull();
  expect(container.querySelector('a[href*="/lab/research/reports/report-1"]')).not.toBeNull();
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-22T09:56:00Z");

  vi.useRealTimers();
});

it("automatically loads the next page when the list sentinel enters the viewport", async () => {
  mocks.fetchWorkspaceActivities.mockResolvedValueOnce(
    activityResponse([activity("event-1", "2026-10-22T09:00:00Z")], "cursor-2")
  );
  await renderWidget();
  const sentinel = container.querySelector('[data-testid="activity-auto-load-sentinel"]');
  expect(sentinel).not.toBeNull();
  mocks.fetchWorkspaceActivities.mockResolvedValueOnce(
    activityResponse([
      activity("event-2", "2026-10-22T08:00:00Z", {
        action: "created",
        changes: [{ field: "name", new_value: "设备采购协作" }],
      }),
    ])
  );
  await dispatchIntersection(sentinel!);

  expect(mocks.fetchWorkspaceActivities).toHaveBeenNthCalledWith(2, "lab", {
    days: "30",
    pagination: "cursor",
    cursor: "cursor-2",
    per_page: 12,
  });
  expect(container.textContent).toContain("更新了设备采购协作");
  expect(container.textContent).toContain("创建了设备采购协作");
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "加载更多动态")).toBe(false);
});

it("does not request the same next page twice while it is loading", async () => {
  const pendingNextPage: { resolve?: (response: unknown) => void } = {};
  mocks.fetchWorkspaceActivities.mockResolvedValueOnce(
    activityResponse([activity("event-1", "2026-10-22T09:00:00Z")], "cursor-2")
  );
  mocks.fetchWorkspaceActivities.mockImplementation(
    () =>
      new Promise((resolve) => {
        pendingNextPage.resolve = resolve;
      })
  );
  await renderWidget();
  const sentinel = container.querySelector('[data-testid="activity-auto-load-sentinel"]');

  await dispatchIntersection(sentinel!);
  await dispatchIntersection(sentinel!);
  expect(mocks.fetchWorkspaceActivities).toHaveBeenCalledTimes(2);

  const resolveNextPage = pendingNextPage.resolve;
  expect(resolveNextPage).toBeDefined();
  await act(async () =>
    resolveNextPage?.({
      ...activityResponse([activity("event-2", "2026-10-22T08:00:00Z")]),
    })
  );

  expect(mocks.fetchWorkspaceActivities).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("更新了设备采购协作");
});

it("does not request another page after the last result", async () => {
  mocks.fetchWorkspaceActivities.mockResolvedValue(activityResponse([activity("event-1", "2026-10-22T09:00:00Z")]));
  await renderWidget();

  expect(container.querySelector('[data-testid="activity-auto-load-sentinel"]')).toBeNull();
  expect(mocks.fetchWorkspaceActivities).toHaveBeenCalledTimes(1);
});

it("keeps loaded events and reports an error when the next page fails", async () => {
  mocks.fetchWorkspaceActivities.mockResolvedValueOnce(
    activityResponse([activity("event-1", "2026-10-22T09:00:00Z")], "cursor-2")
  );
  mocks.fetchWorkspaceActivities.mockRejectedValueOnce(new Error("unavailable"));
  await renderWidget();
  const sentinel = container.querySelector('[data-testid="activity-auto-load-sentinel"]');

  await dispatchIntersection(sentinel!);

  expect(mocks.fetchWorkspaceActivities).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("更新了设备采购协作");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("最近动态暂不可用");
});

it("resets the stream when the time filter changes", async () => {
  mocks.fetchWorkspaceActivities.mockResolvedValue(activityResponse([activity("event-1", "2026-10-22T09:00:00Z")]));
  await renderWidget();
  const ninetyDays = [...container.querySelectorAll("button")].find((button) => button.textContent === "近 90 天");
  await act(async () => ninetyDays?.click());
  await act(async () => undefined);

  expect(mocks.fetchWorkspaceActivities).toHaveBeenLastCalledWith("lab", {
    days: "90",
    pagination: "cursor",
    per_page: 12,
  });
});

it("renders natural empty and error states without using visit records", async () => {
  mocks.fetchWorkspaceActivities.mockResolvedValue(activityResponse([]));
  await renderWidget();
  expect(container.textContent).toContain("暂无业务动态");

  mocks.fetchWorkspaceActivities.mockRejectedValue(new Error("unavailable"));
  const ninetyDays = [...container.querySelectorAll("button")].find((button) => button.textContent === "近 90 天");
  await act(async () => ninetyDays?.click());
  await act(async () => undefined);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("最近动态暂不可用");
});
