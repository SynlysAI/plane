// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IUserProfileProjectSegregation } from "@plane/types";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({ useParams: () => ({ userId: "member-2" }) }));
vi.mock("@plane/hooks", () => ({ useOutsideClickDetector: vi.fn() }));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    /** 使用项目中文文案，保证资料字段在无翻译依赖时可断言。 */
    t: (key: string, params?: Record<string, string>) => {
      const value = key
        .split(".")
        .reduce<unknown>((current, part) => (current as Record<string, unknown>)?.[part], translations);
      return String(value ?? key).replace(/\{(\w+)\}/g, (_, name: string) => params?.[name] ?? name);
    },
  }),
}));
vi.mock("@plane/propel/emoji-icon-picker", () => ({ Logo: () => null }));
vi.mock("@plane/propel/icon-button", () => ({ IconButton: () => null }));
vi.mock("@makeplane/propel/icons", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@makeplane/propel/icons")>();
  return { ...actual, ChevronDownOutline: () => null, EditOutline: () => null };
});
vi.mock("@makeplane/propel/components/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@plane/ui", () => ({ Loader: () => null }));
vi.mock("@/components/common/cover-image", () => ({ CoverImage: () => null }));
vi.mock("@/hooks/store/use-app-theme", () => ({
  useAppTheme: () => ({ profileSidebarCollapsed: true, toggleProfileSidebar: vi.fn() }),
}));
vi.mock("@/hooks/store/use-command-palette", () => ({
  useCommandPalette: () => ({ toggleProfileSettingsModal: vi.fn() }),
}));
vi.mock("@/hooks/store/use-project", () => ({ useProject: () => ({ getProjectById: vi.fn(() => undefined) }) }));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: { id: "member-1" } }) }));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
vi.mock("@/hooks/use-current-time", () => ({
  useCurrentTime: () => ({ currentTime: new Date("2026-01-01T08:00:00Z") }),
}));

const { ProfileSidebar } = await import("@/components/profile/sidebar");

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** 构造接口已返回、但项目 store 尚未加载的资料数据。 */
function buildProfileData(): IUserProfileProjectSegregation {
  return {
    project_data: [
      {
        id: "project-shared",
        name: "共同负责的科研项目",
        logo_props: { in_use: "emoji", emoji: { value: "🧪" } },
        created_issues: 1,
        assigned_issues: 2,
        completed_issues: 1,
        pending_issues: 1,
      },
    ],
    user_data: {
      avatar_url: "",
      cover_image_url: "",
      display_name: "目标成员",
      first_name: "目标",
      last_name: "成员",
      date_joined: new Date("2026-01-01T00:00:00Z"),
      user_timezone: "Asia/Shanghai",
    },
  } as IUserProfileProjectSegregation;
}

/** 挂载资料侧栏并等待头像与项目条目完成渲染。 */
async function renderSidebar() {
  await act(async () => root.render(<ProfileSidebar userProjectsData={buildProfileData()} />));
}

it("项目 store 未加载时使用接口返回的项目名称兜底", async () => {
  await renderSidebar();

  expect(container.textContent).toContain("共同负责的科研项目");
  expect(container.textContent).toContain("目标 成员");
  expect(container.textContent).toContain("50%");
});

it("渲染目标成员基础资料而不是当前登录用户", async () => {
  await renderSidebar();

  expect(container.textContent).toContain("目标成员");
  expect(container.textContent).toContain("目标");
  expect(container.textContent).toContain("Asia/Shanghai");
});
