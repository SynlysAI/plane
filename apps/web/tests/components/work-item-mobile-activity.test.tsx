// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  activityDisabled: null as boolean | null,
  windowSize: [390, 844] as [number, number],
}));

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
  isDescriptionContentEmpty: (html: string | null | undefined) => !html || html === "<p></p>",
}));
vi.mock("@/components/editor/rich-text/description-input", () => ({
  DescriptionInput: () => <div data-testid="description" />,
}));
vi.mock("@/components/core/description-versions", () => ({
  DescriptionVersionsRoot: () => <div data-testid="description-versions" />,
}));
vi.mock("@/components/issues/title-input", () => ({
  IssueTitleInput: () => <div data-testid="title" />,
}));
vi.mock("@/components/issues/issue-detail/parent", () => ({ IssueParentDetail: () => <div /> }));
vi.mock("@/components/issues/issue-detail/issue-activity", () => ({
  IssueActivity: (props: { disabled?: boolean }) => {
    state.activityDisabled = props.disabled ?? false;
    return <div data-testid="activity" />;
  },
}));
vi.mock("@/components/issues/issue-detail-widgets", () => ({
  IssueDetailWidgets: () => <div data-testid="widgets" />,
}));
vi.mock("@/components/issues/peek-overview/properties", () => ({
  PeekOverviewProperties: () => <div data-testid="properties" />,
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    issue: {
      getIssueById: (id: string) =>
        id === "issue-1"
          ? {
              id: "issue-1",
              project_id: "project-1",
              name: "标题",
              sequence_id: 1,
              description_html: "<p></p>",
            }
          : undefined,
    },
    peekIssue: undefined,
  }),
}));
vi.mock("@/hooks/store/use-member", () => ({ useMember: () => ({ getUserDetails: () => null }) }));
vi.mock("@/hooks/use-reload-confirmation", () => ({ default: () => ({ setShowAlert: vi.fn() }) }));
vi.mock("@/hooks/use-window-size", () => ({ default: () => state.windowSize }));
vi.mock("@/services/issue", () => ({ WorkItemVersionService: vi.fn() }));

const { IssueMainContent } = await import("@/components/issues/issue-detail/main-content");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let scrollIntoView: ReturnType<typeof vi.fn>;
let pushState: ReturnType<typeof vi.fn>;
let replaceState: ReturnType<typeof vi.fn>;
const issueOperations = {
  fetch: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
} as never;

function Harness(props: { isArchived?: boolean; isEditable?: boolean }) {
  const [isEditMode, setIsEditMode] = useState(false);

  return (
    <IssueMainContent
      workspaceSlug="ws"
      projectId="project-1"
      issueId="issue-1"
      issueOperations={issueOperations}
      isEditable={props.isEditable ?? true}
      isArchived={props.isArchived ?? false}
      isEditMode={isEditMode}
      onToggleEditMode={setIsEditMode}
    />
  );
}

/** Render the work-item main-content harness for a responsive assertion. */
async function renderMainContent(props: { isArchived?: boolean; isEditable?: boolean } = {}) {
  await act(async () => root.render(<Harness {...props} />));
}

function element(testId: string) {
  const item = container.querySelector(`[data-testid="${testId}"]`);
  expect(item).toBeInstanceOf(HTMLElement);
  return item as HTMLElement;
}

/** Assert that the first element appears before the second in document order. */
function expectBefore(first: HTMLElement, second: HTMLElement) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.activityDisabled = null;
  scrollIntoView = vi.fn();
  pushState = vi.fn();
  replaceState = vi.fn();
  // oxlint-disable-next-line no-extend-native -- jsdom does not implement scrolling.
  Element.prototype.scrollIntoView = scrollIntoView;
  history.pushState = pushState;
  history.replaceState = replaceState;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("places mobile activity before widgets and properties and scrolls to it in place", async () => {
  state.windowSize = [390, 844];
  await renderMainContent();

  const shortcut = container.querySelector<HTMLAnchorElement>('[aria-controls="work-item-activity-issue-1"]');
  expect(shortcut?.textContent).toContain("common.activity");
  expect(shortcut?.getAttribute("href")).toBe("#work-item-activity-issue-1");
  expect(shortcut?.getAttribute("aria-controls")).toBe("work-item-activity-issue-1");
  expectBefore(element("description-versions"), element("activity"));
  expectBefore(element("activity"), element("widgets"));
  expectBefore(element("widgets"), element("properties"));

  let defaultAllowed = true;
  await act(async () => {
    defaultAllowed = shortcut?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })) ?? true;
  });

  expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  expect(defaultAllowed).toBe(false);
  expect(pushState).not.toHaveBeenCalled();
  expect(replaceState).not.toHaveBeenCalled();
});

it("keeps the desktop activity order and hides the mobile shortcut", async () => {
  state.windowSize = [1280, 900];
  await renderMainContent();

  expect(container.querySelector('[aria-controls="work-item-activity-issue-1"]')).toBeNull();
  expect(container.querySelector('[data-testid="properties"]')).toBeNull();
  expectBefore(element("widgets"), element("activity"));
});

it("keeps activity visible but disabled for archived work items on mobile", async () => {
  state.windowSize = [390, 844];
  await renderMainContent({ isArchived: true, isEditable: false });

  expect(element("activity")).not.toBeNull();
  expect(state.activityDisabled).toBe(true);
});
