// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
  setToast: vi.fn(),
  generateWorkItemLink: vi.fn(),
  getIssueById: vi.fn(),
  removeIssue: vi.fn(),
  archiveIssue: vi.fn(),
  restoreIssue: vi.fn(),
  push: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, string | number> = {}) =>
      ({
        "common.actions.copy_link": "复制链接",
        "research.common.untitled": "未命名",
        "research.common.share_type_administrative_work_item": "行政工作项",
        "research.common.share_copied_title": "分享内容已复制",
        "research.common.share_copied_message": "标题和链接已复制到剪贴板。",
        "research.common.share_copy_failed_title": "复制失败",
        "research.common.share_copy_failed_message": "请稍后重试。",
      })[key]?.replaceAll("{title}", String(values.title ?? "")) ?? key,
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@plane/utils", () => ({
  copyTextToClipboard: mocks.copyTextToClipboard,
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
    <button type="button" {...props}>
      <Icon />
    </button>
  ),
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    issue: { getIssueById: mocks.getIssueById },
    removeIssue: mocks.removeIssue,
    archiveIssue: mocks.archiveIssue,
  }),
}));
vi.mock("@/hooks/store/use-issues", () => ({
  useIssues: () => ({ issues: { restoreIssue: mocks.restoreIssue, removeIssue: vi.fn() } }),
}));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ getProjectIdentifierById: () => "ADMIN" }) }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: null }) }));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false, platform: "Linux" }) }));
vi.mock("@/components/issues/issue-layouts/quick-action-dropdowns", () => ({
  WorkItemDetailQuickActions: () => <section aria-label="更多操作" />,
}));
vi.mock("@/components/issues/issue-detail/subscription", () => ({ IssueSubscription: () => <section /> }));

const { IssueDetailQuickActions } = await import("@/components/issues/issue-detail/issue-detail-quick-actions");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.copyTextToClipboard.mockReset();
  mocks.copyTextToClipboard.mockResolvedValue(undefined);
  mocks.setToast.mockReset();
  mocks.generateWorkItemLink.mockReturnValue("/lab/projects/admin/ADMIN-12");
  mocks.getIssueById.mockReturnValue({ id: "issue-1", name: "采购审批", sequence_id: 12, archived_at: null });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("copies an administrative work item with title context", async () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(window, "location");
  Object.defineProperty(window, "location", { value: { origin: "http://pilab.local" }, configurable: true });

  try {
    await act(async () =>
      root.render(<IssueDetailQuickActions workspaceSlug="lab" projectId="admin" issueId="issue-1" />)
    );
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="复制链接"]')?.click());

    expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(
      "Plane 行政工作项: 采购审批 ( http://pilab.local/lab/projects/admin/ADMIN-12 )"
    );
    expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ type: "SUCCESS" }));
  } finally {
    if (locationDescriptor) Object.defineProperty(window, "location", locationDescriptor);
  }
});

it("uses the untitled fallback and reports clipboard failures", async () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(window, "location");
  Object.defineProperty(window, "location", { value: { origin: "http://pilab.local" }, configurable: true });
  mocks.getIssueById.mockReturnValue({ id: "issue-1", name: " ", sequence_id: 12, archived_at: null });
  mocks.copyTextToClipboard.mockRejectedValue(new Error("denied"));

  try {
    await act(async () =>
      root.render(<IssueDetailQuickActions workspaceSlug="lab" projectId="admin" issueId="issue-1" />)
    );
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="复制链接"]')?.click());

    expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(
      "Plane 行政工作项: 未命名 ( http://pilab.local/lab/projects/admin/ADMIN-12 )"
    );
    expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ type: "ERROR" }));
  } finally {
    if (locationDescriptor) Object.defineProperty(window, "location", locationDescriptor);
  }
});
