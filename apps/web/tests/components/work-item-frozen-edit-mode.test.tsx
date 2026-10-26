// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EditorRefApi } from "@plane/editor";

const captured = vi.hoisted(() => ({
  attachmentsDisabled: null as boolean | null,
  descriptionDisabled: null as boolean | null,
  descriptionPlaceholder: null as string | null,
  propertiesDisabled: null as boolean | null,
  widgetsDisabled: null as boolean | null,
  titleDisabled: null as boolean | null,
}));
const issueState = vi.hoisted(() => ({ descriptionHtml: "<p></p>" }));

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/utils", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
  isDescriptionContentEmpty: (html: string | null | undefined) => !html || html === "<p></p>" || html === "<p>   </p>",
}));
vi.mock("@/components/editor/rich-text/description-input", () => ({
  DescriptionInput: (props: { disabled: boolean; placeholder?: string }) => {
    captured.descriptionDisabled = props.disabled;
    captured.descriptionPlaceholder = props.placeholder ?? null;
    return <div data-testid="description" />;
  },
}));
vi.mock("@/components/core/description-versions", () => ({
  DescriptionVersionsRoot: () => <div data-testid="description-versions" />,
}));
vi.mock("@/components/issues/issue-type-switcher", () => ({ IssueTypeSwitcher: () => <div /> }));
vi.mock("@/components/issues/title-input", () => ({
  IssueTitleInput: (props: { disabled: boolean }) => {
    captured.titleDisabled = props.disabled;
    return <div data-testid="title" />;
  },
}));
vi.mock("@/components/issues/issue-detail/parent", () => ({ IssueParentDetail: () => <div /> }));
vi.mock("@/components/issues/issue-detail/reactions", () => ({
  IssueReaction: () => <div data-testid="issue-reaction" />,
}));
vi.mock("@/components/issues/issue-detail/issue-activity", () => ({ IssueActivity: () => <div /> }));
vi.mock("@/components/issues/issue-detail-widgets", () => ({
  IssueDetailWidgets: (props: { attachmentDisabled?: boolean; disabled: boolean }) => {
    captured.widgetsDisabled = props.disabled;
    captured.attachmentsDisabled = props.attachmentDisabled ?? props.disabled;
    return <div data-testid="widgets" />;
  },
}));
vi.mock("@/components/issues/peek-overview/properties", () => ({
  PeekOverviewProperties: (props: { disabled: boolean }) => {
    captured.propertiesDisabled = props.disabled;
    return <div data-testid="properties" />;
  },
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
              description_html: issueState.descriptionHtml,
            }
          : undefined,
    },
    peekIssue: undefined,
    setLastWidgetAction: vi.fn(),
    fetchActivities: vi.fn(),
  }),
}));
vi.mock("@/hooks/store/use-member", () => ({ useMember: () => ({ getUserDetails: () => null }) }));
vi.mock("@/hooks/use-reload-confirmation", () => ({ default: () => ({ setShowAlert: vi.fn() }) }));
vi.mock("@/hooks/use-window-size", () => ({ default: () => [500, 900] }));
vi.mock("@/services/issue", () => ({ WorkItemVersionService: vi.fn() }));

const { IssueMainContent } = await import("@/components/issues/issue-detail/main-content");
const { PeekOverviewIssueDetails } = await import("@/components/issues/peek-overview/issue-detail");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const issueOperations = {
  fetch: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
} as never;

function Harness(props: { isArchived?: boolean; isEditable: boolean }) {
  const [isEditMode, setIsEditMode] = useState(false);
  return (
    <IssueMainContent
      workspaceSlug="ws"
      projectId="project-1"
      issueId="issue-1"
      issueOperations={issueOperations}
      isEditable={props.isEditable}
      isArchived={props.isArchived ?? false}
      isEditMode={isEditMode}
      onToggleEditMode={setIsEditMode}
    />
  );
}

function renderMainContent(isEditable: boolean, isArchived = false) {
  root.render(<Harness isEditable={isEditable} isArchived={isArchived} />);
}

/** Render the peek work-item detail harness with local edit state. */
function PeekHarness(props: { disabled?: boolean; isArchived?: boolean }) {
  const [isEditMode, setIsEditMode] = useState(false);

  return (
    <PeekOverviewIssueDetails
      editorRef={{ current: null } as React.RefObject<EditorRefApi | null>}
      workspaceSlug="ws"
      issueId="issue-1"
      issueOperations={issueOperations}
      disabled={props.disabled ?? false}
      isArchived={props.isArchived ?? false}
      isSubmitting="saved"
      setIsSubmitting={vi.fn()}
      isEditMode={isEditMode}
      onToggleEditMode={setIsEditMode}
    />
  );
}

/** Render the peek detail view with the supplied access state. */
function renderPeekDetails(props: { disabled?: boolean; isArchived?: boolean } = {}) {
  root.render(<PeekHarness {...props} />);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  issueState.descriptionHtml = "<p></p>";
  captured.attachmentsDisabled = null;
  captured.descriptionDisabled = null;
  captured.descriptionPlaceholder = null;
  captured.propertiesDisabled = null;
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
  expect(captured.descriptionPlaceholder).toBeNull();
  expect(container.textContent?.match(/common\.description/g)).toHaveLength(1);
  expect(captured.propertiesDisabled).toBe(false);
  expect(captured.widgetsDisabled).toBe(true);
  expect(captured.attachmentsDisabled).toBe(false);

  await act(async () => editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(container.querySelector("button")?.textContent).toContain("common.done");
  expect(captured.titleDisabled).toBe(false);
  expect(captured.descriptionDisabled).toBe(false);
  expect(captured.propertiesDisabled).toBe(false);
  expect(captured.widgetsDisabled).toBe(false);

  await act(async () => container.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(container.querySelector("button")?.textContent).toContain("common.edit");
  expect(captured.titleDisabled).toBe(true);
  expect(captured.descriptionDisabled).toBe(true);
  expect(captured.propertiesDisabled).toBe(false);
  expect(captured.widgetsDisabled).toBe(true);
});

it("hides the edit entry and stays read-only when the user cannot edit", async () => {
  await act(async () => renderMainContent(false));

  expect(container.querySelector("button")).toBeNull();
  expect(captured.titleDisabled).toBe(true);
  expect(captured.descriptionDisabled).toBe(true);
  expect(captured.descriptionPlaceholder).toBeNull();
  expect(captured.propertiesDisabled).toBe(true);
  expect(captured.widgetsDisabled).toBe(true);
  expect(captured.attachmentsDisabled).toBe(true);
});

it("keeps mobile properties disabled for archived work items", async () => {
  await act(async () => renderMainContent(true, true));

  expect(captured.propertiesDisabled).toBe(true);
  expect(captured.widgetsDisabled).toBe(true);
  expect(captured.attachmentsDisabled).toBe(true);
});

it("hides the read-only placeholder when a description only contains an image", async () => {
  issueState.descriptionHtml = '<image-component src="/assets/receipt.png"></image-component>';
  await act(async () => renderMainContent(true));

  expect(container.textContent).not.toContain("common.description");

  await act(async () => renderPeekDetails());
  expect(container.textContent).not.toContain("common.description_placeholder");
});

it("hides issue reactions under the description in detail and peek views", async () => {
  await act(async () => renderMainContent(true));

  expect(container.querySelector('[data-testid="issue-reaction"]')).toBeNull();
  expect(container.querySelector('[data-testid="description-versions"]')).not.toBeNull();

  await act(async () => renderPeekDetails());

  expect(container.querySelector('[data-testid="issue-reaction"]')).toBeNull();
  expect(container.querySelector('[data-testid="description-versions"]')).not.toBeNull();
});
