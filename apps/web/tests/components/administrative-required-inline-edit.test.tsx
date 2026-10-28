// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  getIssueById: vi.fn(),
  updateIssue: vi.fn(),
  changeModulesInIssue: vi.fn(),
  setToast: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/utils", () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(" ") }));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { ERROR: "error" },
  setToast: mocks.setToast,
}));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ getProjectById: mocks.getProjectById }) }));
vi.mock("@/hooks/store/use-issue-detail", () => ({
  useIssueDetail: () => ({ issue: { getIssueById: mocks.getIssueById } }),
}));
vi.mock("@/components/issues/issue-detail/label/select/label-select", () => ({
  IssueLabelSelect: ({ onSelect }: { onSelect: (values: string[]) => void }) => (
    <div>
      <button type="button" data-testid="clear-label" onClick={() => onSelect([])}>
        clear label
      </button>
      <button type="button" data-testid="set-label" onClick={() => onSelect(["label-1"])}>
        set label
      </button>
    </div>
  ),
}));
vi.mock("@/components/dropdowns/module/dropdown", () => ({
  ModuleDropdown: ({ onChange }: { onChange: (values: string[]) => void }) => (
    <div>
      <button type="button" data-testid="clear-module" onClick={() => onChange([])}>
        clear module
      </button>
      <button type="button" data-testid="set-module" onClick={() => onChange(["module-1", "module-2"])}>
        set module
      </button>
    </div>
  ),
}));

const { IssueLabelSelectRoot } = await import("@/components/issues/issue-detail/label/select/root");
const { IssueModuleSelect } = await import("@/components/issues/issue-detail/module-select");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getProjectById.mockReturnValue({
    id: "project-1",
    is_research_project: false,
    is_module_required: true,
    is_label_required: true,
  });
  mocks.getIssueById.mockReturnValue({
    id: "issue-1",
    project_id: "project-1",
    label_ids: ["label-1"],
    module_ids: ["module-1"],
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("prevents clearing the last required label from issue detail", async () => {
  await act(async () => {
    root.render(
      <IssueLabelSelectRoot
        workspaceSlug="lab"
        projectId="project-1"
        issueId="issue-1"
        values={["label-1"]}
        labelOperations={{ updateIssue: mocks.updateIssue, createLabel: vi.fn() } as never}
      />
    );
  });

  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="clear-label"]')?.click();
  });
  expect(mocks.updateIssue).not.toHaveBeenCalled();
  expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ message: "标签（小组）为必选项。" }));

  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="set-label"]')?.click();
  });
  expect(mocks.updateIssue).toHaveBeenCalledWith("lab", "project-1", "issue-1", { label_ids: ["label-1"] });
});

it("prevents clearing the last required module from issue detail", async () => {
  await act(async () => {
    root.render(
      <IssueModuleSelect
        workspaceSlug="lab"
        projectId="project-1"
        issueId="issue-1"
        issueOperations={{ changeModulesInIssue: mocks.changeModulesInIssue } as never}
      />
    );
  });

  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="clear-module"]')?.click();
  });
  expect(mocks.changeModulesInIssue).not.toHaveBeenCalled();
  expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ message: "模块（财务报销科目）为必选项。" }));

  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="set-module"]')?.click();
  });
  expect(mocks.changeModulesInIssue).toHaveBeenCalledWith("lab", "project-1", "issue-1", ["module-2"], []);
});
