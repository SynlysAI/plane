// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  getIssueNotificationRecipients: vi.fn(),
  updateIssueNotificationRecipients: vi.fn(),
  updateIssueNotificationSelfSubscription: vi.fn(),
  project: { is_research_project: false },
  footerProps: null as null | { load: () => void; save: () => void; setSelfSubscribed: () => void },
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.split(".").reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations) ?? key,
  }),
}));
vi.mock("@plane/hooks", () => ({
  useLocalStorage: () => [{}, vi.fn()],
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ getProjectById: () => mocks.project }),
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({}),
}));
vi.mock("@/services/issue/issue.service", () => ({
  IssueService: class {
    getIssueNotificationRecipients = mocks.getIssueNotificationRecipients;
    updateIssueNotificationRecipients = mocks.updateIssueNotificationRecipients;
    updateIssueNotificationSelfSubscription = mocks.updateIssueNotificationSelfSubscription;
  },
}));
vi.mock("@/components/comments/comment-create", () => ({
  CommentCreate: () => <div>comment editor</div>,
}));
vi.mock("@/components/issues/issue-detail/issue-activity/activity-comment-root", () => ({
  IssueActivityCommentRoot: () => <div>activity list</div>,
}));
vi.mock("@/components/issues/issue-detail/issue-activity/sort-root", () => ({
  ActivitySortRoot: () => <div />,
}));
vi.mock("@/components/issues/issue-detail/issue-activity/filter-root", () => ({
  ActivityFilterRoot: () => <div />,
}));
vi.mock("@/components/issues/issue-detail/issue-activity/helper", () => ({
  useWorkItemCommentOperations: () => ({
    createComment: vi.fn(),
    updateComment: vi.fn(),
    removeComment: vi.fn(),
    uploadCommentAsset: vi.fn(),
  }),
}));
vi.mock("@/components/common/task-notification-recipients", () => ({
  TaskNotificationRecipients: (props: typeof mocks.footerProps) => {
    mocks.footerProps = props;
    return <div data-issue-notification-recipients="" />;
  },
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.project.is_research_project = false;
  mocks.getIssueNotificationRecipients.mockResolvedValue({});
  mocks.updateIssueNotificationRecipients.mockResolvedValue({});
  mocks.updateIssueNotificationSelfSubscription.mockResolvedValue({});
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  mocks.footerProps = null;
});

async function renderActivity(disabled = false) {
  const { IssueActivity } = await import("@/components/issues/issue-detail/issue-activity/root");
  await act(async () => {
    root.render(<IssueActivity workspaceSlug="lab" projectId="project-1" issueId="issue-1" disabled={disabled} />);
  });
  await act(async () => undefined);
}

it("renders the shared footer for administrative issues", async () => {
  await renderActivity();
  expect(container.querySelector("[data-issue-notification-recipients]")).not.toBeNull();
  expect(typeof mocks.footerProps?.load).toBe("function");
  await act(async () => void mocks.footerProps?.load());
  expect(mocks.getIssueNotificationRecipients).toHaveBeenCalledWith("lab", "project-1", "issue-1");
});

it("does not render the administrative footer for research issues", async () => {
  mocks.project.is_research_project = true;
  await renderActivity();
  expect(container.querySelector("[data-issue-notification-recipients]")).toBeNull();
  expect(mocks.getIssueNotificationRecipients).not.toHaveBeenCalled();
});

it("hides the footer when activity is disabled", async () => {
  await renderActivity(true);
  expect(container.querySelector("[data-issue-notification-recipients]")).toBeNull();
});
