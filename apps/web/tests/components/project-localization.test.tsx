// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IProject } from "@plane/types";
import common from "../../../../packages/i18n/src/locales/zh-CN/common.json";
import settings from "../../../../packages/i18n/src/locales/zh-CN/project-settings.json";
import workspace from "../../../../packages/i18n/src/locales/zh-CN/workspace.json";
import { getStateDisplayName } from "@/helpers/work-item-labels";

const mocks = vi.hoisted(() => ({ missingProfile: false }));
const translations = { ...common, ...settings, ...workspace };

/** 读取真实中文词典，保留缺译时的 defaultValue 行为。 */
function translate(key: string, params?: Record<string, unknown>): string {
  if (key === "profile_settings" && mocks.missingProfile) return String(params?.defaultValue ?? key);
  const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], translations);
  return typeof value === "string" ? value : String(params?.defaultValue ?? key);
}

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: translate, currentLocale: "zh-CN" }) }));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({ useParams: () => ({ workspaceSlug: "lab" }), usePathname: () => "/lab" }));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({
    currentProjectDetails: { id: "project" },
    getPartialProjectById: () => ({ id: "project", name: "报告材料" }),
    updateProject: vi.fn(),
  }),
}));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => ({ currentWorkspace: { slug: "lab" } }) }));
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({ getProjectRoleByWorkspaceSlugAndProjectId: () => 20 }),
  useUser: () => ({ data: { display_name: "测试用户" }, signOut: vi.fn() }),
}));
vi.mock("@/hooks/store/use-app-theme", () => ({ useAppTheme: () => ({ toggleAnySidebarDropdown: vi.fn() }) }));
vi.mock("@/hooks/store/use-command-palette", () => ({
  useCommandPalette: () => ({ toggleProfileSettingsModal: vi.fn() }),
}));
vi.mock("@/hooks/use-instance-admin", () => ({ useInstanceAdmin: () => false }));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
vi.mock("@/components/project/archive-restore-modal", () => ({ ArchiveRestoreProjectModal: () => null }));
vi.mock("@/components/project/delete-project-modal", () => ({ DeleteProjectModal: () => null }));
vi.mock("@/components/core/image-picker-popover", () => ({ ImagePickerPopover: () => null }));
vi.mock("@/components/common/cover-image", () => ({ CoverImage: () => null }));
vi.mock("@/components/global", async () => await import("@/components/global/timezone-select"));
vi.mock("@/helpers/cover-image.helper", () => ({ handleCoverImageChange: vi.fn() }));
vi.mock("swr", () => ({
  default: () => ({
    data: {
      timezones: [
        {
          value: "Asia/Shanghai",
          label: "Beijing",
          utc_offset: "UTC+08:00",
          gmt_offset: 8,
        },
      ],
    },
  }),
}));

const { ProjectSettingsSidebarHeader } = await import("@/components/settings/project/sidebar/header");
const { GeneralProjectSettingsControlSection } = await import("@/components/project/settings/control-section");
const { ProjectDetailsForm } = await import("@/components/project/form");
const { UserMenuRoot } = await import("@/components/workspace/sidebar/user-menu-root");
const { PriorityDropdown } = await import("@/components/dropdowns/priority");

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  mocks.missingProfile = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("项目设置标题和危险操作说明使用中文", async () => {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ProjectSettingsSidebarHeader projectId="project" />
        <GeneralProjectSettingsControlSection projectId="project" />
      </MemoryRouter>
    )
  );
  expect(container.textContent).toContain("项目设置");
  expect(container.textContent).toContain(settings.project_settings.general.archive_project.description);
  expect(container.textContent).toContain(settings.project_settings.general.delete_project.description);
  expect(container.textContent).not.toMatch(/Project settings|Archiving a project|When deleting a project/);
});

it("项目编号、创建日期和北京时间遵循中文显示", async () => {
  const project = {
    id: "project",
    name: "报告材料",
    identifier: "PPT",
    description: "",
    network: 2,
    workspace: { id: "workspace" },
    logo_props: {},
    timezone: "Asia/Shanghai",
    created_at: "2026-10-16T01:00:00Z",
  } as IProject;
  await act(async () =>
    root.render(<ProjectDetailsForm project={project} workspaceSlug="lab" projectId="project" isAdmin />)
  );
  expect(container.textContent).toContain("项目编号");
  expect(container.textContent).toContain("2026年10月16日");
  expect(container.textContent).toContain("北京时间 (UTC+08:00)");
  expect(container.textContent).not.toMatch(/Project ID|Oct 16|Beijing/);
});

it("个人菜单有可读名称，词典缺失时也不暴露翻译键", async () => {
  await act(async () => root.render(<UserMenuRoot />));
  expect(container.querySelector('button[aria-label="个人资料设置"]')).not.toBeNull();
  mocks.missingProfile = true;
  await act(async () => root.render(<UserMenuRoot />));
  expect(container.querySelector('button[aria-label="Profile settings"]')).not.toBeNull();
});

it("优先级选择器显示中文的无优先级", async () => {
  await act(async () => root.render(<PriorityDropdown value="none" onChange={() => undefined} />));
  expect(container.textContent).toContain("无");
  expect(container.textContent).not.toContain("None");
});

it("只翻译对应分组的内置状态，保留自定义名称和持久化数据", () => {
  const state = { name: "Backlog", group: "backlog" as const };
  expect(getStateDisplayName(state, translate)).toBe("待办");
  expect(state.name).toBe("Backlog");
  expect(getStateDisplayName({ name: "待导师确认", group: "started" }, translate)).toBe("待导师确认");
  expect(getStateDisplayName({ name: "Backlog", group: "started" }, translate)).toBe("Backlog");
});
