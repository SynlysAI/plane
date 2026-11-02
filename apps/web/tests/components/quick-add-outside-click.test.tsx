// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EIssueLayoutTypes, EIssuesStoreType } from "@plane/types";

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  toggleCreateIssueModal: vi.fn(),
  quickAddCallback: vi.fn(),
  setPromiseToast: vi.fn(),
}));

const quickAddHandlers = vi.hoisted(() => ({
  escape: undefined as ((event: KeyboardEvent) => void) | undefined,
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "lab", projectId: "project-1" }),
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "issue.new": "新建工作项",
        "issue.title.label": "标题",
        "issue.title.required": "请输入标题",
        "issue.add.press_enter": "按 Enter 创建",
      })[key] ?? key,
  }),
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { ERROR: "error", WARNING: "warning" },
  setToast: vi.fn(),
  setPromiseToast: mocks.setPromiseToast,
}));
vi.mock("@makeplane/propel/icons", () => ({
  AddOutline: () => null,
  InfoOutline: () => null,
  WarningTriangleOutline: () => null,
}));
vi.mock("@plane/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  createIssuePayload: (projectId: string, data: Record<string, unknown>) => ({
    project_id: projectId,
    ...data,
  }),
}));
vi.mock("@/hooks/use-keypress", () => ({
  default: (_key: string, callback: (event: KeyboardEvent) => void) => {
    quickAddHandlers.escape = callback;
  },
}));
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

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getProjectById.mockReturnValue({
    id: "project-1",
    is_research_project: true,
    is_module_required: false,
    is_label_required: false,
  });
  mocks.quickAddCallback.mockResolvedValue({ id: "issue-1" });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  quickAddHandlers.escape = undefined;
});

/** 打开快速创建表单并填入标题，返回内联标题输入框。 */
async function openQuickAddWithTitle(title: string) {
  await act(async () => {
    root.render(
      <QuickAddIssueRoot
        layout={EIssueLayoutTypes.LIST}
        prePopulatedData={{ description_html: "<p>行政说明</p>" }}
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

  return input;
}

/** 模拟点击快速创建表单外的区域，并等待外点检测回调执行。 */
async function clickOutsideQuickAdd() {
  await act(async () => {
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it("moves a non-empty title to the full create modal on outside click", async () => {
  await openQuickAddWithTitle("行政采购审批");

  await clickOutsideQuickAdd();

  expect(mocks.quickAddCallback).not.toHaveBeenCalled();
  expect(mocks.setPromiseToast).not.toHaveBeenCalled();
  expect(mocks.toggleCreateIssueModal).toHaveBeenCalledWith(
    true,
    EIssuesStoreType.PROJECT,
    undefined,
    expect.objectContaining({
      description_html: "<p>行政说明</p>",
      name: "行政采购审批",
      project_id: "project-1",
    })
  );
  expect(container.querySelector("form")).toBeNull();
});

it("keeps the old close behavior when the title is blank", async () => {
  await openQuickAddWithTitle("   ");

  await clickOutsideQuickAdd();

  expect(mocks.quickAddCallback).not.toHaveBeenCalled();
  expect(mocks.toggleCreateIssueModal).not.toHaveBeenCalled();
  expect(container.querySelector("form")).toBeNull();
});

it("keeps Escape as an explicit discard action", async () => {
  await openQuickAddWithTitle("行政采购审批");

  await act(async () => {
    quickAddHandlers.escape?.(new KeyboardEvent("keydown", { key: "Escape" }));
  });

  expect(mocks.quickAddCallback).not.toHaveBeenCalled();
  expect(mocks.toggleCreateIssueModal).not.toHaveBeenCalled();
  expect(container.querySelector("form")).toBeNull();
});
