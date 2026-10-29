// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@headlessui/react", () => ({
  Disclosure: ({ children }: { children: (state: { open: boolean }) => React.ReactNode }) => children({ open: false }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/constants", () => ({
  EUserPermissions: { ADMIN: 20, MEMBER: 15, GUEST: 5 },
  EUserPermissionsLevel: { PROJECT: "project", WORKSPACE: "workspace" },
  ROLE: {},
  ROLE_DETAILS: {},
}));
vi.mock("@plane/propel/toast", () => ({ TOAST_TYPE: {}, setToast: vi.fn() }));
vi.mock("@plane/ui", () => {
  const CustomMenu = Object.assign(({ children }: { children: React.ReactNode }) => <div>{children}</div>, {
    MenuItem: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
  });

  return { CustomMenu, CustomSelect: () => null, PopoverMenu: () => null };
});
vi.mock("@plane/utils", () => ({ getFileURL: (value: string) => value }));
vi.mock("lucide-react", () => ({ CircleMinus: () => <span /> }));
vi.mock("@makeplane/propel/icons", () => ({ DeactivatedUserOutline: () => <span />, DeleteOutline: () => <span /> }));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({
    project: { updateMemberRole: vi.fn() },
    workspace: { getWorkspaceMemberDetails: vi.fn() },
  }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: undefined }),
  useUserPermissions: () => ({ getProjectRoleByWorkspaceSlugAndProjectId: () => undefined }),
}));

const { NameColumn: ProjectNameColumn } = await import("@/components/project/settings/member-columns");
const { NameColumn: WorkspaceNameColumn } = await import("@/components/workspace/settings/member-columns");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

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

it("constrains and exposes full Chinese and Latin member names in both member tables", async () => {
  const members = [
    {
      fullName: "科研测试用户".repeat(10),
      member: {
        id: "member-chinese",
        avatar_url: "",
        display_name: "中文长姓名",
        email: "chinese@example.org",
        first_name: "科研测试用户".repeat(10),
        last_name: "",
      },
    },
    {
      fullName: `${"Alexandria".repeat(8)} ${"Researcher".repeat(8)}`,
      member: {
        id: "member-latin",
        avatar_url: "",
        display_name: "Long display name",
        email: "member@example.org",
        first_name: "Alexandria".repeat(8),
        last_name: "Researcher".repeat(8),
      },
    },
  ];

  await act(async () =>
    root.render(
      <>
        {members.map(({ member }) => {
          const setRemoveMemberModal = vi.fn();
          return (
            <React.Fragment key={member.id}>
              <ProjectNameColumn
                rowData={{
                  member,
                  original_role: null,
                  membership_source: "DIRECT",
                  inherits_organization: false,
                }}
                workspaceSlug="lab"
                isAdmin={false}
                currentUser={undefined}
                setRemoveMemberModal={setRemoveMemberModal}
              />
              <WorkspaceNameColumn
                rowData={{ member, role: 15, is_active: true }}
                workspaceSlug="lab"
                isAdmin={false}
                currentUser={undefined}
                setRemoveMemberModal={setRemoveMemberModal}
              />
            </React.Fragment>
          );
        })}
      </>
    )
  );

  const nameCells = container.querySelectorAll<HTMLElement>("[title]");
  expect(nameCells).toHaveLength(4);
  expect(new Set(Array.from(nameCells, (nameCell) => nameCell.title))).toEqual(
    new Set(members.map(({ fullName }) => fullName))
  );
  nameCells.forEach((nameCell) => {
    expect(nameCell.className).toContain("min-w-0");
    expect(nameCell.className).toContain("truncate");
    expect(nameCell.textContent).toBe(nameCell.title);
  });
});
