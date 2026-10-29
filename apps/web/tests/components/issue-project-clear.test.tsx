// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { FormProvider, useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TIssue } from "@plane/types";

const mocks = vi.hoisted(() => ({
  getProjectMemberIds: vi.fn(),
  onClose: vi.fn(),
  onSubmit: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({ useParams: () => ({ workspaceSlug: "lab" }) }));
vi.mock("@plane/constants", () => ({
  API_BASE_URL: "",
  DEFAULT_WORK_ITEM_FORM_VALUES: {
    project_id: null,
    type_id: null,
    name: "",
    description_html: "",
    estimate_point: null,
    state_id: "",
    parent_id: null,
    priority: "none",
    assignee_ids: [],
    label_ids: [],
    cycle_id: null,
    module_ids: null,
    start_date: null,
    target_date: null,
  },
  ETabIndices: { ISSUE_FORM: "issue-form" },
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        clear_project: "清除项目",
        discard: "放弃",
        project_required_to_save: "请选择项目后再保存",
        save: "保存",
        saving: "保存中",
        select_project: "请选择项目",
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
  getUpdateFormDataForReset: vi.fn((_projectId: string | null, values: unknown) => values),
}));
vi.mock("@/components/dropdowns/project/dropdown", () => ({
  ProjectDropdown: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string | null;
    onChange: (value: string) => void;
    placeholder: string;
  }) => (
    <button type="button" onClick={() => onChange("project-2")}>
      {value ?? placeholder}
    </button>
  ),
}));
vi.mock("@/components/issues/issue-modal/components", async () => {
  const { useFormContext } = await import("react-hook-form");
  return {
    IssueDefaultProperties: () => <div>issue-properties</div>,
    IssueDescriptionEditor: ({ editorRef }: { editorRef: { current: unknown } }) => {
      editorRef.current = { isEditorReadyToDiscard: () => true };
      return <div>issue-editor</div>;
    },
    IssueParentTag: () => null,
    IssueProjectSelect: () => {
      const { setValue, watch } = useFormContext<TIssue>();
      const projectId = watch("project_id");

      return (
        <button type="button" onClick={() => setValue("project_id", "project-2", { shouldDirty: true })}>
          {projectId ?? "请选择项目"}
        </button>
      );
    },
    IssueTitleInput: ({ issueTitleRef }: { issueTitleRef: { current: HTMLInputElement | null } }) => (
      <input ref={issueTitleRef} aria-label="标题" />
    ),
  };
});
vi.mock("@/hooks/context/use-issue-modal", () => ({
  useIssueModal: () => ({
    allowedProjectIds: ["project-1", "project-2"],
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
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ getProjectById: vi.fn() }) }));
vi.mock("@/hooks/store/use-project-state", () => ({ useProjectState: () => ({ getStateById: vi.fn() }) }));
vi.mock("@/hooks/store/workspace-draft", () => ({ useWorkspaceDraftIssues: () => ({ moveIssue: vi.fn() }) }));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({
    project: { getProjectMemberIds: mocks.getProjectMemberIds },
  }),
}));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
vi.mock("@/hooks/use-project-issue-properties", () => ({
  useProjectIssueProperties: () => ({ fetchCycles: vi.fn(), fetchMembers: vi.fn() }),
}));
vi.mock("@plane/ui", () => ({
  EModalPosition: { TOP: "top" },
  EModalWidth: { XXL: "xxl" },
  ModalCore: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div>{children}</div> : null,
}));

const { IssueFormRoot } = await import("@/components/issues/issue-modal/form");
const { IssueProjectSelect } = await import("@/components/issues/issue-modal/components/project-select");
const { ConfirmIssueDiscard } = await import("@/components/issues/confirm-issue-discard");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

function ProjectSelectHarness() {
  const methods = useForm<TIssue>({ defaultValues: { project_id: "project-1" } as Partial<TIssue> });

  return (
    <FormProvider {...methods}>
      <IssueProjectSelect control={methods.control} handleFormChange={() => undefined} />
      <output>{methods.watch("project_id") ?? "null"}</output>
    </FormProvider>
  );
}

function IssueFormHarness() {
  return (
    <IssueFormRoot
      projectId={null}
      isCreateMoreToggleEnabled={false}
      onAssetUpload={vi.fn()}
      onCreateMoreToggleChange={vi.fn()}
      onSubmit={mocks.onSubmit}
      onClose={mocks.onClose}
      isDraft={false}
      isDuplicateModalOpen={false}
      handleDuplicateIssueModal={vi.fn()}
      issueTitleRef={{ current: null }}
    />
  );
}

describe("new work item project clearing", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    mocks.getProjectMemberIds.mockReturnValue(["member-1"]);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("clears the selected project and shows the placeholder", async () => {
    await act(async () => root.render(<ProjectSelectHarness />));

    const clearButton = container.querySelector<HTMLButtonElement>('button[aria-label="清除项目"]');
    expect(clearButton).not.toBeNull();

    await act(async () => clearButton!.click());
    expect(container.querySelector("output")?.textContent).toBe("null");
    expect(container.textContent).toContain("请选择项目");
  });

  it("keeps discard available and blocks saving while project is empty", async () => {
    await act(async () => root.render(<IssueFormHarness />));

    expect(container.textContent).toContain("请选择项目后再保存");
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);

    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(mocks.onSubmit).not.toHaveBeenCalled();

    const discardButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "放弃"
    );
    expect(discardButton).toBeDefined();
    expect(discardButton!.disabled).toBe(false);
    await act(async () => discardButton!.click());
    expect(mocks.onClose).toHaveBeenCalledExactlyOnceWith();
  });

  it("restores saving after a project is selected again", async () => {
    await act(async () => root.render(<IssueFormHarness />));
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);

    const selectProject = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "请选择项目"
    );
    expect(selectProject).toBeDefined();
    await act(async () => selectProject!.click());
    expect(selectProject!.textContent).toContain("project-2");
    expect(container.textContent).not.toContain("请选择项目后再保存");

    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });

  it("allows discard while save-as-draft is disabled in the confirmation", async () => {
    const onDiscard = vi.fn();
    const handleClose = vi.fn();
    await act(async () =>
      root.render(
        <ConfirmIssueDiscard isOpen handleClose={handleClose} onDiscard={onDiscard} onConfirm={vi.fn()} saveDisabled />
      )
    );

    const saveButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Save to Drafts"
    );
    expect(saveButton?.disabled).toBe(true);

    const discardButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Discard"
    );
    expect(discardButton?.disabled).toBe(false);
    await act(async () => discardButton!.click());
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
