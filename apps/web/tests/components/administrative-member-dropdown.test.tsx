// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchProjectMembers: vi.fn(),
  getUserDetails: vi.fn(),
  getProjectMemberDetails: vi.fn(),
  getProjectMemberIds: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({ useParams: () => ({ workspaceSlug: "lab" }) }));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "research.assignment.project_group": "项目成员",
        "research.assignment.role_admin": "管理员",
        "research.assignment.role_member": "成员",
        "research.assignment.empty_administrative": "当前行政项目暂无可指派成员",
        you: "我",
        search: "搜索",
        loading: "加载中",
        no_matching_results: "没有匹配的结果",
        members: "成员",
      })[key] ?? key,
  }),
}));

vi.mock("@makeplane/propel/components/avatar", () => ({
  Avatar: ({ alt }: { alt?: string }) => <span aria-label={alt} />,
}));
vi.mock("@makeplane/propel/icons", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  DeactivatedUserOutline: () => <span />,
  MembersOutline: () => <span />,
  SearchOutline: () => <span />,
  TickOutline: () => <span />,
}));
vi.mock("@plane/propel/pill", () => ({
  EPillSize: { XS: "XS" },
  EPillVariant: { DEFAULT: "DEFAULT" },
  Pill: () => <span />,
}));
vi.mock("@plane/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  getFileURL: (value: string) => value,
  sortByCurrentUserThenSelected: (options: unknown) => options,
}));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({
    getUserDetails: mocks.getUserDetails,
    project: {
      fetchProjectMembers: mocks.fetchProjectMembers,
      getProjectMemberDetails: mocks.getProjectMemberDetails,
      getProjectMemberIds: mocks.getProjectMemberIds,
    },
    workspace: { workspaceMemberIds: ["workspace-only"], isUserSuspended: () => false },
  }),
}));
vi.mock("@/hooks/store/user", () => ({ useUser: () => ({ data: { id: "current" } }) }));
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
const { MemberDropdown } = await import("@/components/dropdowns/member/dropdown");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getProjectMemberIds.mockReturnValue(["admin-1", "member-1"]);
  mocks.getUserDetails.mockImplementation((userId: string) => ({ id: userId, display_name: userId }));
  mocks.getProjectMemberDetails.mockImplementation((userId: string) =>
    userId === "admin-1"
      ? { id: "membership-admin", member: { id: userId, display_name: userId }, role: 20 }
      : { id: "membership-member", member: { id: userId, display_name: userId }, role: 15 }
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderDropdown() {
  await act(async () => {
    root.render(
      <MemberDropdown
        projectId="project-1"
        value={[]}
        onChange={vi.fn()}
        multiple
        buttonVariant="border-with-text"
        placeholder="负责人"
      />
    );
  });
  await act(async () => {
    container.querySelector("button")?.click();
  });
}

it("groups administrative assignees by project membership and shows project roles", async () => {
  await renderDropdown();

  expect(document.body.textContent).toContain("项目成员");
  expect(document.body.textContent).toContain("admin-1");
  expect(document.body.textContent).toContain("member-1");
  expect(document.body.textContent).toContain("管理员");
  expect(document.body.textContent).toContain("成员");
  expect(document.body.textContent).not.toContain("workspace-only");
});

it("shows a scoped empty state when the project has no assignable members", async () => {
  mocks.getProjectMemberIds.mockReturnValue([]);
  await renderDropdown();

  expect(document.body.textContent).toContain("当前行政项目暂无可指派成员");
});
