// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useFormContext } from "react-hook-form";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchMembers: vi.fn(),
  getProjectMemberIds: vi.fn(),
  getProjectMemberDetails: vi.fn(),
  getUserDetails: vi.fn(),
  getProjectById: vi.fn(),
  onSubmit: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({ useParams: () => ({ workspaceSlug: "lab" }) }));
vi.mock("@plane/constants", () => ({
  API_BASE_URL: "",
  DEFAULT_WORK_ITEM_FORM_VALUES: { project_id: null, assignee_ids: [], name: "" },
  ETabIndices: { ISSUE_FORM: "issue-form" },
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "research.assignment.empty_administrative": "当前行政项目暂无可指派成员，请先维护项目成员。",
        create_more: "继续创建",
        discard: "取消",
        save: "保存",
        saving: "保存中",
      })[key] ?? key,
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ loading: _loading, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => (
    <button {...props} />
  ),
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { ERROR: "error" },
  setToast: vi.fn(),
}));
vi.mock("@makeplane/propel/components/switch", () => ({ Switch: () => <input type="checkbox" /> }));
vi.mock("@plane/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  convertWorkItemDataToSearchResponse: vi.fn(),
  getChangedIssuefields: vi.fn((data: unknown) => data),
  getTabIndex: () => ({ getIndex: () => 0 }),
  getUpdateFormDataForReset: vi.fn((_projectId: string, values: unknown) => values),
}));
vi.mock("@/components/issues/issue-modal/components", () => ({
  IssueDefaultProperties: () => {
    const { setValue } = useFormContext();
    return (
      <div>
        issue-properties
        <button
          type="button"
          data-testid="fill-required-fields"
          onClick={() => {
            setValue("module_ids", ["module-1"]);
            setValue("label_ids", ["label-1"]);
          }}
        >
          补齐字段
        </button>
      </div>
    );
  },
  IssueDescriptionEditor: ({ editorRef }: { editorRef: { current: unknown } }) => {
    editorRef.current = { isEditorReadyToDiscard: () => true };
    return <div>issue-editor</div>;
  },
  IssueParentTag: () => null,
  IssueProjectSelect: () => <div>issue-project</div>,
  IssueTitleInput: ({ issueTitleRef }: { issueTitleRef: { current: HTMLInputElement | null } }) => (
    <input ref={issueTitleRef} aria-label="标题" />
  ),
}));
vi.mock("@/hooks/context/use-issue-modal", () => ({
  useIssueModal: () => ({
    workItemTemplateId: null,
    isApplyingTemplate: false,
    selectedParentIssue: null,
    setWorkItemTemplateId: vi.fn(),
    setSelectedParentIssue: vi.fn(),
    getIssueTypeIdOnProjectChange: () => null,
    getActiveAdditionalPropertiesLength: () => 0,
    handlePropertyValuesValidation: () => true,
    handleCreateUpdatePropertyValues: vi.fn(),
    handleTemplateChange: vi.fn(),
  }),
}));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({ issue: { getIssueById: vi.fn() } }),
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ getProjectById: mocks.getProjectById }),
}));
vi.mock("@/hooks/store/use-project-state", () => ({ useProjectState: () => ({ getStateById: vi.fn() }) }));
vi.mock("@/hooks/store/workspace-draft", () => ({ useWorkspaceDraftIssues: () => ({ moveIssue: vi.fn() }) }));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({
    getUserDetails: mocks.getUserDetails,
    project: {
      fetchProjectMembers: mocks.fetchMembers,
      getProjectMemberDetails: mocks.getProjectMemberDetails,
      getProjectMemberIds: mocks.getProjectMemberIds,
    },
    workspace: { workspaceMemberIds: [], isUserSuspended: () => false },
  }),
}));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
vi.mock("@/hooks/use-project-issue-properties", () => ({
  useProjectIssueProperties: () => ({
    fetchCycles: vi.fn(),
    fetchMembers: mocks.fetchMembers,
  }),
}));

const { IssueFormRoot } = await import("@/components/issues/issue-modal/form");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getProjectMemberIds.mockReturnValue([]);
  mocks.onSubmit.mockResolvedValue(undefined);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderForm({ isDraft = false, moveToIssue = false }: { isDraft?: boolean; moveToIssue?: boolean } = {}) {
  await act(async () => {
    root.render(
      <IssueFormRoot
        projectId="project-1"
        isCreateMoreToggleEnabled={false}
        onAssetUpload={vi.fn()}
        onCreateMoreToggleChange={vi.fn()}
        onSubmit={mocks.onSubmit}
        onClose={vi.fn()}
        isDraft={isDraft}
        moveToIssue={moveToIssue}
        isDuplicateModalOpen={false}
        handleDuplicateIssueModal={vi.fn()}
        issueTitleRef={{ current: null }}
      />
    );
  });
  await act(async () => undefined);
}

it("blocks submission when the administrative project has no assignable members", async () => {
  await renderForm();

  expect(mocks.fetchMembers).toHaveBeenCalledWith("lab", "project-1");
  expect(container.textContent).toContain("当前行政项目暂无可指派成员，请先维护项目成员。");
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);

  const form = container.querySelector("form");
  assertNotNull(form, "issue form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mocks.onSubmit).not.toHaveBeenCalled();
});

it("blocks draft promotion until required module and label are selected", async () => {
  mocks.getProjectMemberIds.mockReturnValue(["member-1"]);
  mocks.getProjectById.mockReturnValue({
    id: "project-1",
    is_research_project: false,
    is_module_required: true,
    is_label_required: true,
  });
  await renderForm({ isDraft: true, moveToIssue: true });

  const promoteButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "add_to_project"
  );
  assertNotNull(promoteButton, "draft promotion button");
  expect(promoteButton.disabled).toBe(true);

  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="fill-required-fields"]')?.click();
  });
  await act(async () => undefined);
  expect(promoteButton.disabled).toBe(false);
});

it("blocks formal administrative work items until required module and label are selected", async () => {
  mocks.getProjectMemberIds.mockReturnValue(["member-1"]);
  mocks.getProjectById.mockReturnValue({
    id: "project-1",
    is_research_project: false,
    is_module_required: true,
    is_label_required: true,
  });
  await renderForm();

  expect(container.textContent).toContain("请选择模块");
  expect(container.textContent).toContain("请选择标签");
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);

  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="fill-required-fields"]')?.click();
  });
  await act(async () => undefined);
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);

  const form = container.querySelector("form");
  assertNotNull(form, "issue form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mocks.onSubmit).toHaveBeenCalled();
});

it("allows a draft to remain incomplete while required fields are enabled", async () => {
  mocks.getProjectMemberIds.mockReturnValue(["member-1"]);
  mocks.getProjectById.mockReturnValue({
    id: "project-1",
    is_research_project: false,
    is_module_required: true,
    is_label_required: true,
  });
  await renderForm({ isDraft: true });

  expect(container.textContent).not.toContain("请选择模块");
  expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);

  const form = container.querySelector("form");
  assertNotNull(form, "issue form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mocks.onSubmit).toHaveBeenCalled();
});

function assertNotNull<T>(value: T | null, label: string): asserts value is T {
  if (value === null) throw new Error(`${label} not found`);
}
