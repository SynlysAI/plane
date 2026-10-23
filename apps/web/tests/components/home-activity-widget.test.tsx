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

beforeEach(() => {
  cache = new Map();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it("renders actor, object, link, timestamp and grouped real mutations", async () => {
  const now = new Date("2026-10-22T10:00:00Z");
  mocks.fetchWorkspaceActivities.mockResolvedValue({
    results: [
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
    ],
    next_offset: null,
    has_more: false,
    offset: 0,
    per_page: 12,
  });
  vi.setSystemTime(now);

  await renderWidget();

  expect(mocks.fetchWorkspaceActivities).toHaveBeenCalledWith("lab", { days: "30", offset: 0, per_page: 12 });
  expect(container.textContent).toContain("学生一");
  expect(container.textContent).toContain("更新了设备采购协作");
  expect(container.textContent).toContain("提交了WEEKLY 2026-W42");
  expect(container.textContent).toContain("合并 2 次同类更新");
  expect(container.querySelector('a[href*="/lab/projects/project-1/issues"]')).not.toBeNull();
  expect(container.querySelector('a[href*="/lab/research/reports/report-1"]')).not.toBeNull();
  expect(container.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-22T09:56:00Z");

  vi.useRealTimers();
});

it("loads more pages without losing earlier events", async () => {
  mocks.fetchWorkspaceActivities.mockResolvedValueOnce({
    results: [activity("event-1", "2026-10-22T09:00:00Z")],
    next_offset: 12,
    has_more: true,
    offset: 0,
    per_page: 12,
  });
  await renderWidget();
  const loadMore = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("加载更多"));
  mocks.fetchWorkspaceActivities.mockResolvedValueOnce({
    results: [
      activity("event-2", "2026-10-22T08:00:00Z", {
        action: "created",
        changes: [{ field: "name", new_value: "设备采购协作" }],
      }),
    ],
    next_offset: null,
    has_more: false,
    offset: 12,
    per_page: 12,
  });
  await act(async () => loadMore?.click());
  await act(async () => undefined);

  expect(mocks.fetchWorkspaceActivities).toHaveBeenNthCalledWith(2, "lab", {
    days: "30",
    offset: 12,
    per_page: 12,
  });
  expect(container.textContent).toContain("创建了设备采购协作");
});

it("resets the stream when the time filter changes", async () => {
  mocks.fetchWorkspaceActivities.mockResolvedValue({
    results: [activity("event-1", "2026-10-22T09:00:00Z")],
    next_offset: null,
    has_more: false,
    offset: 0,
    per_page: 12,
  });
  await renderWidget();
  const ninetyDays = [...container.querySelectorAll("button")].find((button) => button.textContent === "近 90 天");
  await act(async () => ninetyDays?.click());
  await act(async () => undefined);

  expect(mocks.fetchWorkspaceActivities).toHaveBeenLastCalledWith("lab", {
    days: "90",
    offset: 0,
    per_page: 12,
  });
});

it("renders natural empty and error states without using visit records", async () => {
  mocks.fetchWorkspaceActivities.mockResolvedValue({
    results: [],
    next_offset: null,
    has_more: false,
    offset: 0,
    per_page: 12,
  });
  await renderWidget();
  expect(container.textContent).toContain("暂无业务动态");

  mocks.fetchWorkspaceActivities.mockRejectedValue(new Error("unavailable"));
  const ninetyDays = [...container.querySelectorAll("button")].find((button) => button.textContent === "近 90 天");
  await act(async () => ninetyDays?.click());
  await act(async () => undefined);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("最近动态暂不可用");
});
