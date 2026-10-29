// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TIssue } from "@plane/types";

const mocks = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
  copyUrlToClipboard: vi.fn(),
  generateWorkItemLink: vi.fn(),
  setToast: vi.fn(),
  issue: undefined as unknown,
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, string | number> = {}) =>
      ({
        "common.actions.copy_link": "复制链接",
        "common.link_copied": "链接已复制",
        "common.link_copied_to_clipboard": "链接已复制到剪贴板。",
        "research.common.share_type_administrative_work_item": "行政工作项",
        "research.common.untitled": "未命名",
      })[key]?.replaceAll("{title}", String(values.title ?? "")) ?? key,
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@plane/utils", () => ({
  copyTextToClipboard: mocks.copyTextToClipboard,
  copyUrlToClipboard: mocks.copyUrlToClipboard,
  generateWorkItemLink: mocks.generateWorkItemLink,
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "SUCCESS", ERROR: "ERROR" },
  setToast: mocks.setToast,
}));
vi.mock("@makeplane/propel/components/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@plane/propel/icon-button", () => ({
  IconButton: ({
    icon: Icon,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: React.FC<{ className?: string }> }) => (
    <button type="button" data-testid={Icon.name ?? "icon-button"} {...props}>
      <Icon />
    </button>
  ),
}));
vi.mock("@plane/ui", () => ({
  CustomSelect: Object.assign(({ children }: { children?: React.ReactNode }) => <div>{children}</div>, {
    Option: () => null,
  }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@makeplane/propel/icons", () => ({
  ArrowNarrowRightOutline: () => <svg aria-hidden="true" />,
  DragDropOutline: () => <svg aria-hidden="true" />,
  FullScreenPeekOutline: () => <svg aria-hidden="true" />,
  LinkOutline: () => <svg aria-hidden="true" />,
  ModalPeekOutline: () => <svg aria-hidden="true" />,
  SidePeekOutline: () => <svg aria-hidden="true" />,
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    issue: {
      getIssueById: () => mocks.issue,
      setPeekIssue: vi.fn(),
      removeIssue: vi.fn(),
      archiveIssue: vi.fn(),
      getIsIssuePeeked: () => false,
    },
  }),
}));
vi.mock("@/hooks/store/use-issues", () => ({
  useIssues: () => ({ issues: { removeIssue: vi.fn() } }),
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ getProjectIdentifierById: () => "PRJ17F869" }),
}));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: null }) }));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
vi.mock("@/components/issues/issue-detail/subscription", () => ({
  IssueSubscription: () => <section />,
}));
vi.mock("@/components/issues/issue-layouts/quick-action-dropdowns", () => ({
  WorkItemDetailQuickActions: () => <section />,
}));
vi.mock("@/components/issues/issue-update-status", () => ({
  NameDescriptionUpdateStatus: () => <span />,
}));
vi.mock("@/components/issues/issue-layouts/quick-action-dropdowns/copy-menu-helper", () => ({
  createCopyMenuWithDuplication: () => [],
}));

const { IssuePeekOverviewHeader } = await import("@/components/issues/peek-overview/header");
const { useIssueActionHandlers } = await import("@/components/issues/issue-layouts/quick-action-dropdowns/helper");
const { CreateIssueToastActionItems } = await import("@/components/issues/create-issue-toast-action-items");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const issue = {
  id: "issue-1",
  name: "采购审批",
  project_id: "admin",
  sequence_id: 31,
} as unknown as TIssue;

/** 渲染列表快捷菜单的复制处理钩子。 */
function QuickActionCopyHarness() {
  const { handleCopyIssueLink } = useIssueActionHandlers({
    issue,
    workspaceSlug: "public",
    projectIdentifier: "PRJ17F869",
    isEditingAllowed: true,
    isDeletingAllowed: true,
    setIssueToEdit: vi.fn(),
    setCreateUpdateIssueModal: vi.fn(),
    setDeleteIssueModal: vi.fn(),
  });
  return <button onClick={handleCopyIssueLink}>复制链接</button>;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.copyTextToClipboard.mockReset();
  mocks.copyTextToClipboard.mockResolvedValue(undefined);
  mocks.copyUrlToClipboard.mockReset();
  mocks.copyUrlToClipboard.mockResolvedValue(undefined);
  mocks.generateWorkItemLink.mockReset();
  mocks.generateWorkItemLink.mockReturnValue("/public/browse/PRJ17F869-31/");
  mocks.setToast.mockReset();
  mocks.issue = issue;
  Object.defineProperty(window, "location", {
    value: { origin: "http://pilab.local" },
    configurable: true,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("copies a structured administrative work item link from the quick action menu", async () => {
  await act(async () => root.render(<QuickActionCopyHarness />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());

  expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(
    "OpenEVA 行政工作项: 采购审批 ( http://pilab.local/public/browse/PRJ17F869-31/ )"
  );
  expect(mocks.copyUrlToClipboard).not.toHaveBeenCalled();
});

it("copies a structured administrative work item link from the peek header", async () => {
  await act(async () =>
    root.render(
      <IssuePeekOverviewHeader
        peekMode="side-peek"
        setPeekMode={vi.fn()}
        removeRoutePeekId={vi.fn()}
        workspaceSlug="public"
        projectId="admin"
        issueId="issue-1"
        isArchived={false}
        disabled={false}
        embedIssue={false}
        toggleDeleteIssueModal={vi.fn()}
        toggleArchiveIssueModal={vi.fn()}
        toggleDuplicateIssueModal={vi.fn()}
        toggleEditIssueModal={vi.fn()}
        handleRestoreIssue={vi.fn()}
        isSubmitting="saved"
      />
    )
  );
  await act(async () => container.querySelector<HTMLButtonElement>('button[data-testid="LinkOutline"]')?.click());

  expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(
    "OpenEVA 行政工作项: 采购审批 ( http://pilab.local/public/browse/PRJ17F869-31/ )"
  );
  expect(mocks.copyUrlToClipboard).not.toHaveBeenCalled();
});

it("copies a structured administrative work item link after creation", async () => {
  await act(async () =>
    root.render(<CreateIssueToastActionItems workspaceSlug="public" projectId="admin" issueId="issue-1" />)
  );
  await act(async () =>
    [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Copy link")
      ?.click()
  );

  expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(
    "OpenEVA 行政工作项: 采购审批 ( http://pilab.local/public/browse/PRJ17F869-31/ )"
  );
  expect(mocks.copyUrlToClipboard).not.toHaveBeenCalled();
});
