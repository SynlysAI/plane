// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  context: {
    workspace_enabled: true,
    capabilities: { nav: ["reviews", "reports", "approvals"] },
  },
}));

vi.mock("@/hooks/use-workspace-context", () => ({
  useWorkspaceContext: () => ({ context: mocks.context, error: null, retry: vi.fn() }),
}));
vi.mock("@/components/administrative/approval-panel", () => ({
  AdministrativeApprovalPanel: ({ workspaceSlug }: { workspaceSlug: string }) => (
    <div data-testid="administrative-approvals">{`administrative:${workspaceSlug}`}</div>
  ),
}));
vi.mock("@/components/research/approvals/research-approval-center", () => ({
  ResearchApprovalCenter: ({ workspaceSlug }: { workspaceSlug: string }) => (
    <div data-testid="research-approvals">{`research:${workspaceSlug}`}</div>
  ),
}));
vi.mock("@/components/research/common/research-todo-index", () => ({
  ResearchTodoEnvelopeList: ({ workspaceSlug }: { workspaceSlug: string }) => (
    <section aria-label="跨组件待办">{`shared-todos:${workspaceSlug}`}</section>
  ),
}));

const { default: WorkspaceApprovalsPage } = await import("@/app/(all)/[workspaceSlug]/(projects)/approvals/page");
const { default: LegacyResearchApprovalsPage } =
  await import("@/app/(all)/[workspaceSlug]/(projects)/research/approvals/page");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let currentPath = "";

function PathProbe() {
  const location = useLocation();
  currentPath = `${location.pathname}${location.search}`;
  return null;
}

async function renderPage(initialPath: string) {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/:workspaceSlug/approvals" element={<WorkspaceApprovalsPage />} />
          <Route path="/:workspaceSlug/research/approvals" element={<LegacyResearchApprovalsPage />} />
        </Routes>
        <PathProbe />
      </MemoryRouter>
    )
  );
}

function topTabNames() {
  return Array.from(container.querySelectorAll('nav[aria-label="审批类型"] button')).map(
    (button) => button.textContent
  );
}

function findTab(name: string) {
  return Array.from(container.querySelectorAll('nav[aria-label="审批类型"] button')).find(
    (button) => button.textContent === name
  );
}

beforeEach(() => {
  mocks.context = {
    workspace_enabled: true,
    capabilities: { nav: ["reviews", "reports", "approvals"] },
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  currentPath = "";
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("将跨组件待办置于行政审批与科研审批同级且默认展示", async () => {
  await renderPage("/lab/approvals");

  expect(topTabNames()).toEqual(["跨组件待办", "行政审批", "科研审批"]);
  expect(container.querySelector('section[aria-label="跨组件待办"]')?.textContent).toBe("shared-todos:lab");
  expect(container.querySelector('[data-testid="administrative-approvals"]')).toBeNull();
  expect(container.querySelector('[data-testid="research-approvals"]')).toBeNull();
});

it("无科研权限时仍显示跨组件待办与行政审批", async () => {
  mocks.context = { workspace_enabled: true, capabilities: { nav: [] } };

  await renderPage("/lab/approvals?domain=research&todo_scope=visible");

  expect(topTabNames()).toEqual(["跨组件待办", "行政审批"]);
  expect(container.querySelector('section[aria-label="跨组件待办"]')?.textContent).toBe("shared-todos:lab");
  expect(findTab("跨组件待办")?.getAttribute("aria-current")).toBe("page");
  expect(container.querySelector('[data-testid="research-approvals"]')).toBeNull();
});

it("科研审批内部不再重复渲染跨组件待办", async () => {
  await renderPage("/lab/approvals?domain=research&tab=report_review&todo_scope=visible");

  expect(findTab("科研审批")?.getAttribute("aria-current")).toBe("page");
  expect(container.querySelector('[data-testid="research-approvals"]')?.textContent).toBe("research:lab");
  expect(container.querySelectorAll('section[aria-label="跨组件待办"]')).toHaveLength(0);
});

it("切换页面级页签时保留待办范围并清理队列参数", async () => {
  await renderPage("/lab/approvals?domain=shared_todos&todo_scope=visible&tab=report_review");

  await act(async () => findTab("科研审批")?.click());
  expect(currentPath).toBe("/lab/approvals?todo_scope=visible&domain=research");

  await act(async () => findTab("行政审批")?.click());
  expect(currentPath).toBe("/lab/approvals?todo_scope=visible&domain=administrative");
});

it("兼容历史科研审批深链", async () => {
  await renderPage("/lab/research/approvals?tab=report_review&todo_scope=visible");
  expect(currentPath).toBe("/lab/approvals?domain=research&tab=report_review&todo_scope=visible");

  await act(async () => root.unmount());
  root = createRoot(container);
  await renderPage("/lab/research/approvals?tab=shared_todos&todo_scope=visible");
  expect(currentPath).toBe("/lab/approvals?domain=shared_todos&todo_scope=visible");
});
