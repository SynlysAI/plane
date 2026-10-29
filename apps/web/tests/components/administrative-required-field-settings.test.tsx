// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  updateProject: vi.fn(),
  fetchModules: vi.fn(),
  fetchProjectLabels: vi.fn(),
  getProjectModuleDetails: vi.fn(),
  getProjectLabels: vi.fn(),
}));

vi.mock("mobx-react", () => ({
  enableStaticRendering: vi.fn(),
  observer: (component: unknown) => component,
}));
vi.mock("react-router", () => ({ useParams: () => ({ workspaceSlug: "lab" }) }));
vi.mock("@plane/propel/toast", () => ({ setPromiseToast: vi.fn() }));
vi.mock("@makeplane/propel/components/switch", () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    "aria-label": ariaLabel,
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange: (value: boolean) => void;
    "aria-label"?: string;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    />
  ),
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({
    getProjectById: mocks.getProjectById,
    updateProject: mocks.updateProject,
  }),
}));
vi.mock("@/hooks/store/use-module", () => ({
  useModule: () => ({
    fetchModules: mocks.fetchModules,
    getProjectModuleDetails: mocks.getProjectModuleDetails,
  }),
}));
vi.mock("@/hooks/store/use-label", () => ({
  useLabel: () => ({
    fetchProjectLabels: mocks.fetchProjectLabels,
    getProjectLabels: mocks.getProjectLabels,
  }),
}));

const { AdministrativeRequiredFieldSettings } =
  await import("@/components/project/settings/administrative-required-fields");

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
    module_view: true,
    is_module_required: false,
    is_label_required: false,
  });
  mocks.getProjectModuleDetails.mockReturnValue([
    { id: "module-1", name: "设备采购" },
    { id: "module-2", name: "  " },
  ]);
  mocks.getProjectLabels.mockReturnValue([
    { id: "label-1", name: "01器件" },
    { id: "label-2", name: "" },
  ]);
  mocks.updateProject.mockResolvedValue({});
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderSettings() {
  await act(async () => {
    root.render(<AdministrativeRequiredFieldSettings projectId="project-1" />);
  });
}

it("shows administrative required-field controls and updates project settings", async () => {
  await renderSettings();

  expect(container.textContent).toContain("行政工作项必填项");
  expect(mocks.fetchModules).toHaveBeenCalledWith("lab", "project-1");
  expect(mocks.fetchProjectLabels).toHaveBeenCalledWith("lab", "project-1");
  expect(container.textContent).toContain("设备采购、未命名模块");
  expect(container.textContent).toContain("01器件、未命名标签");

  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="模块必选"]')?.click();
  });
  expect(mocks.updateProject).toHaveBeenCalledWith("lab", "project-1", { is_module_required: true });

  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="标签必选"]')?.click();
  });
  expect(mocks.updateProject).toHaveBeenCalledWith("lab", "project-1", { is_label_required: true });
});

it("hides required-field controls for research projects", async () => {
  mocks.getProjectById.mockReturnValue({ id: "project-1", is_research_project: true });
  await renderSettings();

  expect(container.textContent).not.toContain("行政工作项必填项");
});

it("disables unavailable required-field switches", async () => {
  mocks.getProjectById.mockReturnValue({
    id: "project-1",
    is_research_project: false,
    module_view: false,
    is_module_required: false,
    is_label_required: false,
  });
  mocks.getProjectModuleDetails.mockReturnValue([]);
  mocks.getProjectLabels.mockReturnValue([]);
  await renderSettings();

  expect(container.querySelector<HTMLButtonElement>('button[aria-label="模块必选"]')?.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="标签必选"]')?.disabled).toBe(true);
});

it("disables switches while project options are loading", async () => {
  mocks.getProjectModuleDetails.mockReturnValue(null);
  mocks.getProjectLabels.mockReturnValue(undefined);
  await renderSettings();

  expect(container.textContent).toContain("正在读取模块");
  expect(container.textContent).toContain("正在读取标签");
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="模块必选"]')?.disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="标签必选"]')?.disabled).toBe(true);
});
