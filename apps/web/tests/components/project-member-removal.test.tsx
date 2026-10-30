// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@headlessui/react", () => ({
  Disclosure: ({ children }: { children: (state: { open: boolean }) => React.ReactNode }) => children({ open: false }),
}));
vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ projectId: "project" }) }));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/constants", () => ({
  EUserPermissions: { ADMIN: 20, MEMBER: 15, GUEST: 5 },
  ROLE: {},
  ROLE_DETAILS: {},
}));
vi.mock("@plane/propel/toast", () => ({ TOAST_TYPE: {}, setToast: vi.fn() }));
vi.mock("@plane/ui", () => {
  const CustomMenu = Object.assign(
    ({ children }: { children: React.ReactNode }) => <div data-testid="project-member-menu">{children}</div>,
    {
      MenuItem: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => (
        <button type="button" onClick={onClick}>
          {children}
        </button>
      ),
    }
  );

  return {
    CustomMenu,
    CustomSelect: () => null,
    EModalPosition: { CENTER: "center" },
    EModalWidth: { XXL: "xxl" },
    ModalCore: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});
vi.mock("@plane/utils", () => ({ getFileURL: (value: string) => value }));
vi.mock("lucide-react", () => ({ CircleMinus: () => <span /> }));
vi.mock("@makeplane/propel/icons", () => ({ WarningTriangleOutline: () => <span /> }));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({ project: { updateMemberRole: vi.fn() }, workspace: { getWorkspaceMemberDetails: vi.fn() } }),
}));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ getProjectById: () => ({ name: "Office" }) }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: { id: "requester" } }),
  useUserPermissions: () => ({ getProjectRoleByWorkspaceSlugAndProjectId: () => undefined }),
}));

const { NameColumn } = await import("@/components/project/settings/member-columns");
const { ConfirmProjectMemberRemove } = await import("@/components/project/confirm-project-member-remove");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: Root;

const member = {
  id: "inherited-member",
  avatar_url: "",
  display_name: "Inherited Member",
  email: "inherited@example.com",
  first_name: "Inherited",
  last_name: "Member",
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows the remove action for inherited members to project admins", async () => {
  const setRemoveMemberModal = vi.fn();

  await act(async () =>
    root.render(
      <NameColumn
        rowData={{
          member,
          original_role: null,
          membership_source: "ORGANIZATION",
          inherits_organization: true,
        }}
        workspaceSlug="lab"
        isAdmin
        currentUser={{ id: "requester" } as never}
        setRemoveMemberModal={setRemoveMemberModal}
      />
    )
  );

  const action = container.querySelector<HTMLButtonElement>("[data-testid='project-member-menu'] button");
  expect(action).not.toBeNull();
  await act(async () => action?.click());
  expect(setRemoveMemberModal).toHaveBeenCalledExactlyOnceWith({
    member,
    original_role: null,
    membership_source: "ORGANIZATION",
    inherits_organization: true,
  });
});

it("keeps inherited member removal unavailable to non-admins", async () => {
  await act(async () =>
    root.render(
      <NameColumn
        rowData={{
          member,
          original_role: null,
          membership_source: "ORGANIZATION",
          inherits_organization: true,
        }}
        workspaceSlug="lab"
        isAdmin={false}
        currentUser={{ id: "requester" } as never}
        setRemoveMemberModal={vi.fn()}
      />
    )
  );

  expect(container.querySelector("[data-testid='project-member-menu']")).toBeNull();
});

it("explains project-only revocation in the confirmation modal", async () => {
  await act(async () =>
    root.render(
      <ConfirmProjectMemberRemove
        isOpen
        data={{ id: member.id, display_name: member.display_name }}
        isInheritedOnly
        onSubmit={vi.fn().mockResolvedValue(undefined)}
        onClose={vi.fn()}
      />
    )
  );

  expect(container.textContent).toContain("project_settings.members.confirm_revoke_description");
});
