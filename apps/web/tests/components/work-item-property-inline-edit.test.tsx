// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  setToast: vi.fn(),
  mainContentEditMode: null as boolean | null,
  permissionAllowed: true,
  peekDetailsEditMode: null as boolean | null,
  peekMode: null as string | null,
  peekPropertiesDisabled: null as boolean | null,
  peekWidgetsDisabled: null as boolean | null,
  sidebarEditable: null as boolean | null,
  sidebarIssueOperations: null as { update: (...args: unknown[]) => Promise<void> } | null,
}));

const issueDetailStore = vi.hoisted(() => ({
  issue: {
    getIssueById: (id: string) =>
      ({
        "issue-1": { id: "issue-1", project_id: "project-1", name: "工作项一" },
        "issue-2": { id: "issue-2", project_id: "project-1", name: "工作项二" },
      })[id],
  },
  setPeekIssue: vi.fn(),
  isAnyModalOpen: false,
  fetchIssue: vi.fn(),
  updateIssue: vi.fn(),
  removeIssue: vi.fn(),
  archiveIssue: vi.fn(),
  addCycleToIssue: vi.fn(),
  addIssueToCycle: vi.fn(),
  removeIssueFromCycle: vi.fn(),
  changeModulesInIssue: vi.fn(),
  removeIssueFromModule: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === "issue.label") {
        return options?.count === 1 ? "工作项" : "{count, plural, one {工作项} other {工作项}}";
      }
      if (key === "entity.update.failed") {
        return `${options?.entity}更新失败`;
      }
      return key;
    },
  }),
}));
vi.mock("@plane/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { ERROR: "error", SUCCESS: "success" },
  setPromiseToast: vi.fn(),
  setToast: captured.setToast,
}));
vi.mock("@/app/assets/empty-state/issue.svg?url", () => ({ default: "issue.svg" }));
vi.mock("@/components/common/empty-state", () => ({ EmptyState: () => <div /> }));
vi.mock("@/components/issues/issue-detail/main-content", () => ({
  IssueMainContent: (props: { isEditMode: boolean; onToggleEditMode: (value: boolean) => void }) => {
    captured.mainContentEditMode = props.isEditMode;
    return (
      <button type="button" data-testid="detail-edit-toggle" onClick={() => props.onToggleEditMode(!props.isEditMode)}>
        toggle
      </button>
    );
  },
}));
vi.mock("@/components/issues/issue-detail/sidebar", () => ({
  IssueDetailsSidebar: (props: {
    isEditable: boolean;
    issueOperations: { update: (...args: unknown[]) => Promise<void> };
  }) => {
    captured.sidebarEditable = props.isEditable;
    captured.sidebarIssueOperations = props.issueOperations;
    return <div data-testid="detail-properties" />;
  },
}));
vi.mock("@/components/issues/peek-overview", () => ({ IssuePeekOverview: () => <div /> }));
vi.mock("@/components/issues/peek-overview/error", () => ({ IssuePeekOverviewError: () => <div /> }));
vi.mock("@/components/issues/peek-overview/header", () => ({
  IssuePeekOverviewHeader: (props: { peekMode: string; setPeekMode: (value: "side-peek" | "full-screen") => void }) => {
    captured.peekMode = props.peekMode;
    return (
      <button
        type="button"
        data-testid="peek-mode-toggle"
        onClick={() => props.setPeekMode(props.peekMode === "full-screen" ? "side-peek" : "full-screen")}
      >
        mode
      </button>
    );
  },
}));
vi.mock("@/components/issues/peek-overview/issue-detail", () => ({
  PeekOverviewIssueDetails: (props: { isEditMode: boolean; onToggleEditMode: (value: boolean) => void }) => {
    captured.peekDetailsEditMode = props.isEditMode;
    return (
      <button type="button" data-testid="peek-edit-toggle" onClick={() => props.onToggleEditMode(!props.isEditMode)}>
        toggle
      </button>
    );
  },
}));
vi.mock("@/components/issues/peek-overview/loader", () => ({ IssuePeekOverviewLoader: () => <div /> }));
vi.mock("@/components/issues/peek-overview/properties", () => ({
  PeekOverviewProperties: (props: { disabled: boolean }) => {
    captured.peekPropertiesDisabled = props.disabled;
    return <div data-testid="peek-properties" />;
  },
}));
vi.mock("@/components/issues/issue-detail-widgets", () => ({
  IssueDetailWidgets: (props: { disabled: boolean }) => {
    captured.peekWidgetsDisabled = props.disabled;
    return <div data-testid="peek-widgets" />;
  },
}));
vi.mock("@/components/issues/issue-detail/issue-activity", () => ({ IssueActivity: () => <div /> }));
vi.mock("@/hooks/store/use-app-theme", () => ({
  useAppTheme: () => ({ issueDetailSidebarCollapsed: false }),
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({ useIssueDetail: () => issueDetailStore }));
vi.mock("@/hooks/store/use-issues", () => ({
  useIssues: () => ({ issues: { removeIssue: vi.fn() } }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({ allowPermissions: () => captured.permissionAllowed }),
}));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-keypress", () => ({ default: vi.fn() }));
vi.mock("@/hooks/use-peek-overview-outside-click", () => ({ default: vi.fn() }));

const { IssueDetailRoot } = await import("@/components/issues/issue-detail/root");
const { IssueView } = await import("@/components/issues/peek-overview/view");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const issueOperations = {
  fetch: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  restore: vi.fn(),
} as never;

/** Render one isolated element into the current test container. */
function renderElement(element: React.ReactElement) {
  root.render(element);
}

/** Dispatch a click event on the first element matching the test id. */
async function clickByTestId(testId: string) {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  expect(element).toBeTruthy();
  await act(async () => element?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

/** Render the standard work-item detail root for the given issue. */
function renderDetailRoot(issueId: string, isArchived = false) {
  renderElement(
    <IssueDetailRoot workspaceSlug="ws" projectId="project-1" issueId={issueId} is_archived={isArchived} />
  );
}

/** Render an embedded work-item peek view with the specified access state. */
function renderPeekView(disabled = false, isArchived = false) {
  renderElement(
    <IssueView
      workspaceSlug="ws"
      projectId="project-1"
      issueId="issue-1"
      is_archived={isArchived}
      disabled={disabled}
      embedIssue
      issueOperations={issueOperations}
    />
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  captured.setToast.mockReset();
  issueDetailStore.updateIssue.mockReset();
  captured.sidebarIssueOperations = null;
  captured.mainContentEditMode = null;
  captured.permissionAllowed = true;
  captured.peekDetailsEditMode = null;
  captured.peekMode = null;
  captured.peekPropertiesDisabled = null;
  captured.peekWidgetsDisabled = null;
  captured.sidebarEditable = null;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("keeps detail properties editable while title and description stay frozen", async () => {
  await act(async () => renderDetailRoot("issue-1"));

  expect(captured.mainContentEditMode).toBe(false);
  expect(captured.sidebarEditable).toBe(true);

  await act(async () => clickByTestId("detail-edit-toggle"));
  expect(captured.mainContentEditMode).toBe(true);
  expect(captured.sidebarEditable).toBe(true);

  await act(async () => clickByTestId("detail-edit-toggle"));
  expect(captured.mainContentEditMode).toBe(false);
  expect(captured.sidebarEditable).toBe(true);
});

it("keeps detail properties disabled without permission or after archiving", async () => {
  captured.permissionAllowed = false;
  await act(async () => renderDetailRoot("issue-1"));
  expect(captured.sidebarEditable).toBe(false);

  captured.permissionAllowed = true;
  await act(async () => renderDetailRoot("issue-1", true));
  expect(captured.sidebarEditable).toBe(false);
});

it("resets detail editing when switching work items", async () => {
  await act(async () => renderDetailRoot("issue-1"));
  await act(async () => clickByTestId("detail-edit-toggle"));
  expect(captured.mainContentEditMode).toBe(true);

  await act(async () => renderDetailRoot("issue-2"));
  expect(captured.mainContentEditMode).toBe(false);
});

it("keeps peek properties editable while widgets require edit mode", async () => {
  await act(async () => renderPeekView());

  expect(captured.peekDetailsEditMode).toBe(false);
  expect(captured.peekWidgetsDisabled).toBe(true);
  expect(captured.peekPropertiesDisabled).toBe(false);

  await act(async () => clickByTestId("peek-edit-toggle"));
  expect(captured.peekWidgetsDisabled).toBe(false);
  expect(captured.peekPropertiesDisabled).toBe(false);

  await act(async () => clickByTestId("peek-mode-toggle"));
  expect(captured.peekMode).toBe("full-screen");
  expect(captured.peekWidgetsDisabled).toBe(false);
  expect(captured.peekPropertiesDisabled).toBe(false);
});

it("keeps peek properties disabled without permission or after archiving", async () => {
  await act(async () => renderPeekView(true));
  expect(captured.peekPropertiesDisabled).toBe(true);

  await act(async () => renderPeekView(false, true));
  expect(captured.peekPropertiesDisabled).toBe(true);
});

it("shows the backend field error when a work item update fails", async () => {
  issueDetailStore.updateIssue.mockRejectedValueOnce({ module_ids: ["模块为必选项。"] });
  await act(async () => renderDetailRoot("issue-1"));

  await act(async () => {
    await captured.sidebarIssueOperations?.update("ws", "project-1", "issue-1", { assignee_ids: ["member-1"] });
  });

  expect(captured.setToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: "模块为必选项。" }));
});

it("uses a readable work item fallback message without raw ICU syntax", async () => {
  issueDetailStore.updateIssue.mockRejectedValueOnce(new Error("network unavailable"));
  await act(async () => renderDetailRoot("issue-1"));

  await act(async () => {
    await captured.sidebarIssueOperations?.update("ws", "project-1", "issue-1", { assignee_ids: ["member-1"] });
  });

  expect(captured.setToast).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message: "工作项更新失败" }));
});
