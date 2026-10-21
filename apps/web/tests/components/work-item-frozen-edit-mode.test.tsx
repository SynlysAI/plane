// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  descriptionDisabled: null as boolean | null,
  widgetsDisabled: null as boolean | null,
  titleDisabled: null as boolean | null,
}));

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));
vi.mock("@/components/editor/rich-text/description-input", () => ({
  DescriptionInput: (props: { disabled: boolean }) => {
    captured.descriptionDisabled = props.disabled;
    return <div data-testid="description" />;
  },
}));
vi.mock("@/components/core/description-versions", () => ({ DescriptionVersionsRoot: () => <div /> }));
vi.mock("@/components/issues/issue-type-switcher", () => ({ IssueTypeSwitcher: () => <div /> }));
vi.mock("@/components/issues/title-input", () => ({
  IssueTitleInput: (props: { disabled: boolean }) => {
    captured.titleDisabled = props.disabled;
    return <div data-testid="title" />;
  },
}));
vi.mock("@/components/issues/issue-detail/parent", () => ({ IssueParentDetail: () => <div /> }));
vi.mock("@/components/issues/issue-detail/reactions", () => ({ IssueReaction: () => <div /> }));
vi.mock("@/components/issues/issue-detail/issue-activity", () => ({ IssueActivity: () => <div /> }));
vi.mock("@/components/issues/issue-detail-widgets", () => ({
  IssueDetailWidgets: (props: { disabled: boolean }) => {
    captured.widgetsDisabled = props.disabled;
    return <div data-testid="widgets" />;
  },
}));
vi.mock("@/components/issues/peek-overview/properties", () => ({ PeekOverviewProperties: () => <div /> }));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({
    issue: {
      getIssueById: (id: string) =>
        id === "issue-1"
          ? { id: "issue-1", project_id: "project-1", name: "标题", sequence_id: 1, description_html: "<p></p>" }
          : undefined,
    },
    peekIssue: undefined,
    setLastWidgetAction: vi.fn(),
    fetchActivities: vi.fn(),
  }),
}));
vi.mock("@/hooks/store/use-member", () => ({ useMember: () => ({ getUserDetails: () => null }) }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: { id: "user-1" } }) }));
vi.mock("@/hooks/use-reload-confirmation", () => ({ default: () => ({ setShowAlert: vi.fn() }) }));
vi.mock("@/hooks/use-window-size", () => ({ default: () => [1440, 900] }));
vi.mock("@/services/issue", () => ({ WorkItemVersionService: vi.fn() }));

const { IssueMainContent } = await import("@/components/issues/issue-detail/main-content");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const issueOperations = {
  fetch: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
} as never;

function Harness(props: { isEditable: boolean }) {
  const [isEditMode, setIsEditMode] = useState(false);
  return (
    <IssueMainContent
      workspaceSlug="ws"
      projectId="project-1"
      issueId="issue-1"
      issueOperations={issueOperations}
      isEditable={props.isEditable}
      isArchived={false}
      isEditMode={isEditMode}
      onToggleEditMode={setIsEditMode}
    />
  );
}

function renderMainContent(isEditable: boolean) {
  root.render(<Harness isEditable={isEditable} />);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  captured.descriptionDisabled = null;
  captured.widgetsDisabled = null;
  captured.titleDisabled = null;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("renders frozen by default and toggles editing through the edit button", async () => {
  await act(async () => renderMainContent(true));

  const editButton = container.querySelector("button");
  expect(editButton?.textContent).toContain("common.edit");
  expect(captured.titleDisabled).toBe(true);
  expect(captured.descriptionDisabled).toBe(true);
  expect(captured.widgetsDisabled).toBe(true);

  await act(async () => editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(container.querySelector("button")?.textContent).toContain("common.done");
  expect(captured.titleDisabled).toBe(false);
  expect(captured.descriptionDisabled).toBe(false);
  expect(captured.widgetsDisabled).toBe(false);

  await act(async () => container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(container.querySelector("button")?.textContent).toContain("common.edit");
  expect(captured.titleDisabled).toBe(true);
  expect(captured.descriptionDisabled).toBe(true);
  expect(captured.widgetsDisabled).toBe(true);
});

it("hides the edit entry and stays read-only when the user cannot edit", async () => {
  await act(async () => renderMainContent(false));

  expect(container.querySelector("button")).toBeNull();
  expect(captured.titleDisabled).toBe(true);
  expect(captured.descriptionDisabled).toBe(true);
  expect(captured.widgetsDisabled).toBe(true);
});
