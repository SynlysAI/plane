// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import type { IIssueDisplayFilterOptions, IIssueDisplayProperties } from "@plane/types";
import { WorkspaceIssuesFilter } from "@/store/issue/workspace/filter.store";
import { EIssueFilterType } from "@plane/constants";

const storeMocks = vi.hoisted(() => ({
  fetchDefaultLayout: vi.fn(),
  fetchIssuesWithExistingPagination: vi.fn(),
}));

const headerMocks = vi.hoisted(() => ({
  filters: {} as { displayFilters?: IIssueDisplayFilterOptions; displayProperties?: IIssueDisplayProperties },
  updateFilters: vi.fn(),
  fetchDefaultLayout: vi.fn(),
  updateDefaultLayout: vi.fn(),
  mutateDefaultLayout: vi.fn(),
  isAdmin: true,
  globalViewId: "all-issues",
  defaultLayout: null as null | {
    display_filters: IIssueDisplayFilterOptions;
    display_properties: IIssueDisplayProperties;
    updated_at: string | null;
  },
  setToast: vi.fn(),
}));

function remoteLayout(overrides: Partial<IIssueDisplayFilterOptions> = {}) {
  return {
    display_filters: {
      calendar: { show_weekends: false, layout: "month" },
      group_by: null,
      sub_group_by: null,
      layout: "spreadsheet",
      order_by: "-created_at",
      show_empty_groups: true,
      sub_issue: true,
      ...overrides,
    },
    display_properties: { key: false, state: true, priority: true },
    updated_at: "2026-10-28T00:00:00Z",
  };
}

function createFilterStore() {
  const rootStore = {
    currentUserId: "user-1",
    workspaceIssues: { fetchIssuesWithExistingPagination: storeMocks.fetchIssuesWithExistingPagination },
  };
  const store = new WorkspaceIssuesFilter(rootStore as never);
  store.issueFilterService = {
    fetchAdministrativeViewDefault: storeMocks.fetchDefaultLayout,
  } as never;
  return store;
}

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("uses the workspace default for system views and ignores browser-local layouts", async () => {
  storeMocks.fetchDefaultLayout.mockResolvedValue(remoteLayout({ layout: "list", order_by: "-updated_at" }));
  const results = await Promise.all(
    (["all-issues", "assigned", "created", "subscribed"] as const).map(async (viewId) => {
      const store = createFilterStore();
      const localGet = vi.spyOn(store.handleIssuesLocalFilters, "get").mockReturnValue({
        display_filters: { layout: "kanban", order_by: "priority" },
      });

      await store.fetchFilters("lab", viewId);
      return { localGet, store, viewId };
    })
  );

  for (const { localGet, store, viewId } of results) {
    expect(storeMocks.fetchDefaultLayout).toHaveBeenCalledWith("lab");
    expect(store.getIssueFilters(viewId)?.displayFilters.layout).toBe("list");
    expect(store.getIssueFilters(viewId)?.displayFilters.order_by).toBe("-updated_at");
    expect(localGet).not.toHaveBeenCalled();
  }
});

it("falls back to the built-in system layout when the default endpoint fails", async () => {
  const store = createFilterStore();
  storeMocks.fetchDefaultLayout.mockRejectedValue(new Error("unavailable"));

  await expect(store.fetchFilters("lab", "assigned")).resolves.toBeUndefined();

  expect(store.getIssueFilters("assigned")?.displayFilters.layout).toBe("spreadsheet");
  expect(store.getIssueFilters("assigned")?.displayFilters.order_by).toBe("-created_at");
});

it("keeps system-view display changes as session-only previews", async () => {
  const store = createFilterStore();
  storeMocks.fetchDefaultLayout.mockResolvedValue(remoteLayout());
  const localSet = vi.spyOn(store.handleIssuesLocalFilters, "set").mockImplementation(() => undefined);
  await store.fetchFilters("lab", "created");

  await store.updateFilters("lab", undefined, EIssueFilterType.DISPLAY_FILTERS, { layout: "list" }, "created");

  expect(store.getIssueFilters("created")?.displayFilters.layout).toBe("list");
  expect(localSet).not.toHaveBeenCalled();
  expect(storeMocks.fetchIssuesWithExistingPagination).toHaveBeenCalledWith("lab", "created", "mutation");
});

vi.mock("@/services/workspace.service", () => ({
  WorkspaceService: class {
    fetchAdministrativeViewDefault = headerMocks.fetchDefaultLayout;
    updateAdministrativeViewDefault = headerMocks.updateDefaultLayout;
  },
}));

vi.mock("mobx-react", () => ({
  enableStaticRendering: vi.fn(),
  observer: (component: unknown) => component,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "lab", globalViewId: headerMocks.globalViewId }),
}));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/store/use-issues", () => ({
  useIssues: () => ({
    issuesFilter: {
      filters: {
        "all-issues": headerMocks.filters,
        "custom-view": headerMocks.filters,
      },
      updateFilters: headerMocks.updateFilters,
    },
  }),
}));
vi.mock("@/hooks/store/use-global-view", () => ({
  useGlobalView: () => ({
    currentWorkspaceViews: [],
    getViewDetailsById: (id: string) => (id === "custom-view" ? { is_locked: false } : undefined),
  }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({ allowPermissions: () => headerMocks.isAdmin }),
}));
vi.mock("swr", async () => {
  const actual = await vi.importActual<typeof import("swr")>("swr");
  return {
    ...actual,
    default: (key: string | null) => ({
      data: key?.includes("WORKSPACE_ADMINISTRATIVE_VIEW_DEFAULT") ? headerMocks.defaultLayout : undefined,
      mutate: headerMocks.mutateDefaultLayout,
    }),
  };
});
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@plane/propel/toast", () => ({
  setToast: headerMocks.setToast,
  TOAST_TYPE: { SUCCESS: "success", ERROR: "error" },
}));
vi.mock("@plane/ui", () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Test-local header stub.
  const Header = ({ children }: { children: React.ReactNode }) => <header>{children}</header>;
  Header.LeftItem = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Header.RightItem = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Test-local breadcrumb stub.
  const Breadcrumbs = ({ children }: { children: React.ReactNode }) => <nav>{children}</nav>;
  Breadcrumbs.Item = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  return {
    Header,
    Breadcrumbs,
    BreadcrumbNavigationSearchDropdown: () => <span>view-switcher</span>,
  };
});
vi.mock("@/components/issues/issue-layouts/filters", () => ({
  FiltersDropdown: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <button type="button">{title}</button>
      {children}
    </div>
  ),
  DisplayFiltersSelection: () => <div>display-filters</div>,
}));
vi.mock("@/components/work-item-filters/filters-toggle", () => ({
  WorkItemFiltersToggle: () => <button type="button">work-item-filters</button>,
}));
vi.mock("@/components/workspace/views/modal", () => ({
  CreateUpdateWorkspaceViewModal: () => <div>view-modal</div>,
}));
vi.mock("@/components/workspace/views/quick-action", () => ({
  WorkspaceViewQuickActions: () => <div>custom-actions</div>,
}));
vi.mock("@/components/workspace/views/default-view-quick-action", () => ({
  DefaultWorkspaceViewQuickActions: () => <div>default-actions</div>,
}));
vi.mock("@/components/common/detail-back-link", () => ({
  DetailBackLink: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const { GlobalIssuesHeader } = await import("../../app/(all)/[workspaceSlug]/(projects)/workspace-views/header");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function renderHeader() {
  await act(async () =>
    root.render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <GlobalIssuesHeader />
      </SWRConfig>
    )
  );
}

beforeEach(() => {
  headerMocks.globalViewId = "all-issues";
  headerMocks.isAdmin = true;
  headerMocks.filters = {
    displayFilters: { layout: "kanban", order_by: "-updated_at" },
    displayProperties: { key: true, state: false },
  };
  headerMocks.defaultLayout = remoteLayout();
  headerMocks.updateDefaultLayout.mockResolvedValue(remoteLayout({ layout: "kanban", order_by: "-updated_at" }));
  headerMocks.mutateDefaultLayout.mockResolvedValue(headerMocks.defaultLayout);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("lets a workspace admin publish changed display settings to everyone", async () => {
  await renderHeader();
  const saveButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "保存为全员默认布局"
  );
  expect(saveButton).toBeDefined();

  await act(async () => saveButton?.click());

  expect(headerMocks.updateDefaultLayout).toHaveBeenCalledWith("lab", {
    display_filters: { layout: "kanban", order_by: "-updated_at" },
    display_properties: { key: true, state: false },
  });
  expect(headerMocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ title: "已同步给全部成员" }));
});

it("hides display configuration for members on system views", async () => {
  headerMocks.isAdmin = false;
  await renderHeader();

  expect(container.textContent).not.toContain("common.display");
  expect(container.textContent).toContain("布局由工作区管理员统一设置");
  expect(container.textContent).not.toContain("保存为全员默认布局");
  expect(container.textContent).toContain("work-item-filters");
});

it("keeps custom-view display settings unchanged", async () => {
  headerMocks.globalViewId = "custom-view";
  headerMocks.isAdmin = false;
  await renderHeader();

  expect(container.textContent).toContain("显示");
  expect(container.textContent).not.toContain("布局由工作区管理员统一设置");
});
