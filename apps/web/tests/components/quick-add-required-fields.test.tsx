// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EIssueLayoutTypes, EIssuesStoreType } from "@plane/types";

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  toggleCreateIssueModal: vi.fn(),
  quickAddCallback: vi.fn(),
  setToast: vi.fn(),
  setPromiseToast: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "lab", projectId: "project-1" }),
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "common.success": "成功",
        "common.error.label": "错误！",
        "common.error.message": "发生错误。请重试。",
        "issue.adding": "创建中",
        "issue.create.success": "创建成功",
        "issue.new": "新建工作项",
        "issue.title.label": "标题",
        "issue.title.required": "请输入标题",
        "issue.add.press_enter": "按 Enter 创建",
      })[key] ?? key,
  }),
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { ERROR: "error", WARNING: "warning" },
  setToast: mocks.setToast,
  setPromiseToast: mocks.setPromiseToast,
}));
vi.mock("@makeplane/propel/icons", () => ({ AddOutline: () => null }));
vi.mock("@plane/ui", () => ({
  Row: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
}));
vi.mock("@plane/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  createIssuePayload: (projectId: string, data: Record<string, unknown>) => ({
    project_id: projectId,
    ...data,
  }),
}));
vi.mock("@plane/hooks", () => ({ useOutsideClickDetector: () => {} }));
vi.mock("@/hooks/use-keypress", () => ({ default: () => {} }));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ getProjectById: mocks.getProjectById }),
}));
vi.mock("@/hooks/store/use-command-palette", () => ({
  useCommandPalette: () => ({ toggleCreateIssueModal: mocks.toggleCreateIssueModal }),
}));
vi.mock("@/components/issues/create-issue-toast-action-items", () => ({
  CreateIssueToastActionItems: () => null,
}));

const { QuickAddIssueRoot } = await import("@/components/issues/issue-layouts/quick-add/root");
const { formatIssueCreateError } = await import("@/components/issues/required-fields");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getProjectById.mockReturnValue(undefined);
  mocks.quickAddCallback.mockResolvedValue({ id: "issue-1" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

/** Render the shared quick add root and submit the given title through the list form. */
async function submitQuickAdd(title: string, prePopulatedData?: Record<string, unknown>) {
  await act(async () => {
    root.render(
      <QuickAddIssueRoot
        layout={EIssueLayoutTypes.LIST}
        prePopulatedData={prePopulatedData}
        quickAddCallback={mocks.quickAddCallback}
      />
    );
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>("button")?.click();
  });
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  if (!input) throw new Error("quick add input not found");
  const setInputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setInputValue?.call(input, title);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const form = container.querySelector("form");
  if (!form) throw new Error("quick add form not found");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

it("guides to the full modal when module and label are both required", async () => {
  mocks.getProjectById.mockReturnValue({
    id: "project-1",
    is_research_project: false,
    is_module_required: true,
    is_label_required: true,
  });
  await submitQuickAdd("报销申请");

  expect(mocks.quickAddCallback).not.toHaveBeenCalled();
  expect(mocks.setToast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "warning",
      title: "无法快速创建",
      message: expect.stringContaining("模块、标签"),
    })
  );
  expect(mocks.toggleCreateIssueModal).toHaveBeenCalledWith(
    true,
    EIssuesStoreType.PROJECT,
    undefined,
    expect.objectContaining({ name: "报销申请" })
  );
});

it("keeps the normal quick add flow when the required module is pre-populated", async () => {
  mocks.getProjectById.mockReturnValue({
    id: "project-1",
    is_research_project: false,
    is_module_required: true,
    is_label_required: false,
  });
  await submitQuickAdd("报销申请", { module_ids: ["module-1"] });

  expect(mocks.quickAddCallback).toHaveBeenCalledWith(
    "project-1",
    expect.objectContaining({ name: "报销申请", module_ids: ["module-1"] })
  );
  expect(mocks.setToast).not.toHaveBeenCalled();
  expect(mocks.toggleCreateIssueModal).not.toHaveBeenCalled();
});

it("only lists the label when the module requirement is disabled", async () => {
  mocks.getProjectById.mockReturnValue({
    id: "project-1",
    is_research_project: false,
    is_module_required: false,
    is_label_required: true,
  });
  await submitQuickAdd("报销申请");

  const toast = mocks.setToast.mock.calls[0]?.[0] as { message: string } | undefined;
  expect(toast?.message).toContain("标签");
  expect(toast?.message).not.toContain("模块");
  expect(mocks.toggleCreateIssueModal).toHaveBeenCalled();
});

it("keeps quick add unchanged for projects without required fields", async () => {
  mocks.getProjectById.mockReturnValue({
    id: "project-1",
    is_research_project: true,
    is_module_required: false,
    is_label_required: false,
  });
  await submitQuickAdd("实验记录");

  expect(mocks.quickAddCallback).toHaveBeenCalledWith("project-1", expect.objectContaining({ name: "实验记录" }));
  expect(mocks.setToast).not.toHaveBeenCalled();
  expect(mocks.toggleCreateIssueModal).not.toHaveBeenCalled();
});

it("still calls the API when required-field flags are missing from project details", async () => {
  mocks.getProjectById.mockReturnValue({ id: "project-1" });
  await submitQuickAdd("报销申请");

  expect(mocks.quickAddCallback).toHaveBeenCalled();
  expect(mocks.setToast).not.toHaveBeenCalled();
});

it("maps backend required-field errors to readable toast messages", () => {
  const backendError = {
    module_ids: ["模块为必选项。"],
    label_ids: ["标签为必选项。"],
  };
  expect(formatIssueCreateError(backendError, "发生错误。请重试。")).toBe(
    "模块为必选项。标签为必选项。请在完整创建窗口中补充必填项。"
  );
  expect(formatIssueCreateError({ error: "权限不足" }, "发生错误。请重试。")).toBe("权限不足");
  expect(formatIssueCreateError(new Error("网络中断"), "发生错误。请重试。")).toBe("网络中断");
  expect(formatIssueCreateError(undefined, "发生错误。请重试。")).toBe("发生错误。请重试。");
});

it("wires the promise toast to the shared error formatter", async () => {
  mocks.getProjectById.mockReturnValue({ id: "project-1" });
  await submitQuickAdd("报销申请");

  const toastOptions = mocks.setPromiseToast.mock.calls[0]?.[1] as
    | { error: { message: (error: unknown) => string } }
    | undefined;
  expect(toastOptions?.error.message({ module_ids: ["模块为必选项。"], label_ids: ["标签为必选项。"] })).toBe(
    "模块为必选项。标签为必选项。请在完整创建窗口中补充必填项。"
  );
});
