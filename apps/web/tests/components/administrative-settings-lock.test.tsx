// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lockEnabled: true,
  updateProject: vi.fn(),
}));

vi.mock("@/hooks/use-administrative-settings-lock", () => ({
  useAdministrativeSettingsLock: () => mocks.lockEnabled,
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({
    getProjectById: () => ({ module_view: true, is_module_required: false }),
    updateProject: mocks.updateProject,
  }),
}));
vi.mock("@plane/propel/toast", () => ({
  setPromiseToast: vi.fn(),
}));
vi.mock("@makeplane/propel/components/switch", () => ({
  Switch: (props: { checked: boolean; disabled?: boolean; onCheckedChange: () => void }) => (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={props.onCheckedChange}
    >
      toggle
    </button>
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

const { ProjectSettingsFeatureControlItem } =
  await import("@/components/settings/project/content/feature-control-item");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lockEnabled = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

it("disables administrative module configuration and explains the lock", async () => {
  await act(async () =>
    root.render(
      <ProjectSettingsFeatureControlItem
        description="项目成员将能够创建和编辑模块。"
        featureProperty="module_view"
        projectId="project-id"
        title="启用模块"
        value
        workspaceSlug="workspace-slug"
      />
    )
  );

  const toggle = container.querySelector<HTMLButtonElement>('button[role="switch"]');
  expect(toggle?.disabled).toBe(true);
  expect(toggle?.getAttribute("aria-checked")).toBe("true");
  expect(container.textContent).toContain("该项已由工作区管理员统一设置。");

  await act(async () => toggle?.click());
  expect(mocks.updateProject).not.toHaveBeenCalled();
});
