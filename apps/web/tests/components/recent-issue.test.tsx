// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TActivityEntityData } from "@plane/types";

const setPeekIssue = vi.fn();
const setPeekEpic = vi.fn();
const peekState: { peekIssue?: unknown } = {};
const listItemProps: {
  itemLink: string;
  onItemClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}[] = [];

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/utils", () => ({
  calculateTimeAgo: () => "less than a minute ago",
  generateWorkItemLink: () => "/lab/browse/PRJA121C6-1/",
}));
vi.mock("@plane/propel/icons", () => ({
  PriorityIcon: () => <span aria-label="priority" />,
  StateGroupIcon: () => <span aria-label="state" />,
}));
vi.mock("@makeplane/propel/icons", () => ({ WorkItemsOutline: () => <span aria-label="work-item" /> }));
vi.mock("@makeplane/propel/components/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/core/list", () => ({
  ListItem: (props: {
    title: string;
    itemLink: string;
    prependTitleElement: React.ReactNode;
    onItemClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  }) => {
    listItemProps.push(props);
    return (
      <div>
        <span>{props.title}</span>
        <div data-testid="prepend">{props.prependTitleElement}</div>
        <button
          type="button"
          onClick={() =>
            props.onItemClick?.({
              preventDefault: vi.fn(),
              stopPropagation: vi.fn(),
            } as React.MouseEvent<HTMLAnchorElement>)
          }
        >
          open
        </button>
      </div>
    );
  },
}));
vi.mock("@/components/dropdowns/member/dropdown", () => ({ MemberDropdown: () => null }));
vi.mock("@/components/issues/peek-overview", () => ({
  IssuePeekOverview: () => <div data-testid="issue-peek-overview" />,
}));
vi.mock("@/components/issues/issue-detail/issue-identifier", () => ({
  IssueIdentifier: ({ projectIdentifier, issueSequenceId }: { projectIdentifier: string; issueSequenceId: string }) => (
    <span>{`${projectIdentifier}-${issueSequenceId}`}</span>
  ),
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: (serviceType: string) =>
    serviceType === "epics"
      ? { setPeekIssue: setPeekEpic }
      : {
          get peekIssue() {
            return peekState.peekIssue;
          },
          setPeekIssue: (peekIssue: unknown) => {
            peekState.peekIssue = peekIssue;
            setPeekIssue(peekIssue);
          },
        },
}));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ getProjectIdentifierById: () => "PRJA121C6" }) }));
vi.mock("@/hooks/store/use-project-state", () => ({
  useProjectState: () => ({ getStateById: () => ({ name: "待处理", group: "backlog", color: "#000", order: 1 }) }),
}));

const { RecentIssue } = await import("@/components/home/widgets/recents/issue");
const { HomePeekOverviewsRoot } = await import("@/components/issues/peek-overview/peek-overviews");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  listItemProps.length = 0;
  peekState.peekIssue = undefined;
  setPeekIssue.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** Create one recent work-item visit with or without a work-item type. */
function recentIssue(type: string | null): TActivityEntityData {
  return {
    id: "recent-issue",
    entity_name: "issue",
    entity_identifier: "issue-id",
    visited_at: "2026-10-20T08:00:00Z",
    entity_data: {
      id: "issue-id",
      name: "tt",
      state: "state-id",
      priority: "none",
      assignees: [],
      type,
      sequence_id: 1,
      project_id: "project-id",
      project_identifier: "PRJA121C6",
      is_epic: false,
    },
  } as TActivityEntityData;
}

it.each(["task-type", null])("renders a typed or untyped work item without its identifier (%s)", async (type) => {
  const parentRef = { current: document.createElement("div") };

  await act(async () => root.render(<RecentIssue activity={recentIssue(type)} ref={parentRef} workspaceSlug="lab" />));

  expect(container.textContent).toContain("tt");
  expect(container.textContent).not.toContain("PRJA121C6-1");
});

it("keeps the work-item link and renders peek details after removing the identifier", async () => {
  const parentRef = { current: document.createElement("div") };

  /** 渲染最近动态任务与首页 Peek 容器，用于验证点击后的状态链路。 */
  const renderRecentActivity = () =>
    root.render(
      <>
        <RecentIssue activity={recentIssue("task-type")} ref={parentRef} workspaceSlug="lab" />
        <HomePeekOverviewsRoot />
      </>
    );

  await act(async () => renderRecentActivity());
  expect(container.querySelector('[data-testid="issue-peek-overview"]')).toBeNull();
  await act(async () => container.querySelector("button")?.click());
  await act(async () => renderRecentActivity());

  expect(listItemProps.at(-1)?.itemLink).toBe("/lab/browse/PRJA121C6-1/");
  expect(setPeekIssue).toHaveBeenCalledWith({
    workspaceSlug: "lab",
    projectId: "project-id",
    issueId: "issue-id",
  });
  expect(container.querySelector('[data-testid="issue-peek-overview"]')).not.toBeNull();
});
