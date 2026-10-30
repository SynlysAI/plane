// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  updateProject: vi.fn(),
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
vi.mock("@/hooks/use-administrative-settings-lock", () => ({
  useAdministrativeSettingsLock: () => false,
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({
    getProjectById: mocks.getProjectById,
    updateProject: mocks.updateProject,
  }),
}));
vi.mock("@/components/settings/heading", () => ({
  SettingsHeading: ({ title, description }: { title: string; description: string }) => (
    <div>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  ),
}));
vi.mock("@/components/settings/boxed-control-item", () => ({
  SettingsBoxedControlItem: ({
    title,
    description,
    control,
  }: {
    title: React.ReactNode;
    description?: React.ReactNode;
    control: React.ReactNode;
  }) => (
    <section>
      <div>{title}</div>
      <div>{description}</div>
      {control}
    </section>
  ),
}));

const { AdministrativeConfigurationPermissionSettings } =
  await import("@/components/project/settings/administrative-configuration-permission");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  mocks.getProjectById.mockReturnValue({
    id: "project-1",
    is_research_project: false,
    administrative_settings_admin_only: false,
  });
  mocks.updateProject.mockResolvedValue({});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it("shows and saves the project-level administrative lock", async () => {
  await act(async () => {
    root.render(<AdministrativeConfigurationPermissionSettings projectId="project-1" />);
  });

  expect(container.textContent).toContain("行政项目配置权限");
  expect(container.textContent).toContain("行政项目配置仅管理员可设置");
  expect(container.textContent).toContain("按项目控制模块、标签与视图配置权");

  await act(async () => {
    container.querySelector<HTMLButtonElement>('button[aria-label="行政项目配置仅管理员可设置"]')?.click();
  });
  expect(mocks.updateProject).toHaveBeenCalledWith("lab", "project-1", {
    administrative_settings_admin_only: true,
  });
});

it("hides the project-level lock for research projects", async () => {
  mocks.getProjectById.mockReturnValue({ id: "project-1", is_research_project: true });
  await act(async () => {
    root.render(<AdministrativeConfigurationPermissionSettings projectId="project-1" />);
  });

  expect(container.textContent).not.toContain("行政项目配置权限");
});
