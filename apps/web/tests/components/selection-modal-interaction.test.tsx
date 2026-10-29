// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(),
  addMember: vi.fn(),
  projectAddMembers: vi.fn(),
  fetchTagGroups: vi.fn(),
  close: vi.fn(),
  tagGroups: [
    {
      id: "member-tags",
      name: "成员标签",
      sort_order: 0,
      tags: [
        { id: "tag-core", group_id: "member-tags", name: "核心", color: "sage", sort_order: 0 },
        { id: "tag-lead", group_id: "member-tags", name: "负责人", color: "mist", sort_order: 1 },
      ],
    },
  ],
  projectMembers: {
    "admin-user": {
      id: "admin-user",
      role: 20,
      tags: [
        { id: "tag-core", group_id: "member-tags", name: "核心", color: "sage", sort_order: 0 },
        { id: "tag-lead", group_id: "member-tags", name: "负责人", color: "mist", sort_order: 1 },
      ],
      member: {
        id: "admin-user",
        first_name: "金",
        last_name: "帅",
        display_name: "jinshuai0821",
        email: "jinshuai0821@example.com",
        avatar_url: "",
      },
    },
    "member-user": {
      id: "member-user",
      role: 15,
      tags: [{ id: "tag-core", group_id: "member-tags", name: "核心", color: "sage", sort_order: 0 }],
      member: {
        id: "member-user",
        first_name: "李",
        last_name: "建智",
        display_name: "lijianzhi",
        email: "lijianzhi@example.com",
        avatar_url: "",
      },
    },
    "guest-user": {
      id: "guest-user",
      role: 5,
      tags: [{ id: "tag-lead", group_id: "member-tags", name: "负责人", color: "mist", sort_order: 1 }],
      member: {
        id: "guest-user",
        first_name: "洪",
        last_name: "贵春",
        display_name: "hongguichun",
        email: "hongguichun@example.com",
        avatar_url: "",
      },
    },
  },
}));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("use-font-face-observer", () => ({ default: () => true }));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "success", ERROR: "error", WARNING: "warning" },
  setToast: vi.fn(),
}));
vi.mock("@plane/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@plane/utils")>()),
  getFileURL: (url: string) => url,
}));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({
    project: {
      getProjectMemberDetails: () => null,
      bulkAddMembersToProject: mocks.projectAddMembers,
    },
    workspace: {
      fetchWorkspaceMemberTagGroups: mocks.fetchTagGroups,
      workspaceMemberTagGroups: { lab: mocks.tagGroups },
      workspaceMemberIds: Object.keys(mocks.projectMembers),
      getWorkspaceMemberDetails: (memberId: string) => mocks.projectMembers[memberId],
    },
  }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({
    getProjectRoleByWorkspaceSlugAndProjectId: () => 20,
  }),
}));
vi.mock("@plane/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@plane/ui")>();
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const CustomSelectComponent = ({
    children,
    onChange,
    value,
  }: {
    children: React.ReactNode;
    onChange: (value: string) => void;
    value?: string | number;
  }) => (
    <select
      aria-label="project member role"
      value={String(value ?? "")}
      onChange={(event) => onChange(event.target.value)}
    >
      {children}
    </select>
  );
  CustomSelectComponent.Option = ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  );
  return {
    ...actual,
    ModalCore: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CustomSelect: CustomSelectComponent,
  };
});
vi.mock("@/hooks/use-platform-os", () => ({ usePlatformOS: () => ({ isMobile: false }) }));
vi.mock("@/hooks/store/use-project", () => ({
  useProject: () => ({ getProjectById: (id: string) => ({ id, name: "Equipment", identifier: "EQ", logo_props: {} }) }),
}));
vi.mock("@/services/research/navigation.service", () => ({
  ResearchNavigationService: class {
    getAssignableAdministrativeOrganizationMembers = async () => [
      { id: "user-1", name: "Alice", email: "alice@example.test" },
    ];
    addAdministrativeOrganizationMember = mocks.addMember;
  },
}));
vi.mock("@/components/empty-state/simple-empty-state-root", () => ({ SimpleEmptyState: () => null }));
vi.mock("@/components/issues/issue-detail/issue-identifier", () => ({ IssueIdentifier: () => <span>EQ-1</span> }));

import { ProjectMultiSelectModal } from "@/components/project/multi-select-modal";
import { AdministrativeOrganizationManager } from "@/components/research/navigation/administrative-organization-manager";
import { ExistingIssuesListModal } from "@/components/core/modals/existing-issues-list-modal";
import { SendProjectInvitationModal } from "@/components/project/send-project-invitation-modal";
import { setToast } from "@plane/propel/toast";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.submit.mockResolvedValue(undefined);
  mocks.addMember.mockResolvedValue(undefined);
  mocks.fetchTagGroups.mockResolvedValue(mocks.tagGroups);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

async function openOptions() {
  const input = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }))
  );
  const option = document.querySelector<HTMLElement>('[role="option"]')!;
  expect(option).not.toBeNull();
  return option;
}

async function openAndSelect() {
  const option = await openOptions();
  await act(async () =>
    option.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }))
  );
}

/** 用完整指针事件选择一个真实 Combobox 选项。 */
async function clickOption(option: HTMLElement) {
  await act(async () => {
    option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    option.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    option.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });
}

function interactive(node: HTMLElement) {
  for (let current: HTMLElement | null = node; current; current = current.parentElement) {
    expect(current.inert, `${node.textContent} must remain interactive`).not.toBe(true);
    expect(current.getAttribute("aria-hidden")).not.toBe("true");
  }
}

it("can confirm multiple projects immediately after selecting an option", async () => {
  await act(async () =>
    root.render(
      <ProjectMultiSelectModal
        isOpen
        onClose={mocks.close}
        projectIds={["project-1"]}
        selectedProjectIds={[]}
        onSubmit={mocks.submit}
      />
    )
  );
  await openAndSelect();
  const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === "confirm"
  )!;
  expect(confirm.disabled).toBe(false);
  interactive(confirm);
  await act(async () => confirm.click());
  expect(mocks.submit).toHaveBeenCalledWith(["project-1"]);
});

it("can choose a role and add organization members while the member list stays open", async () => {
  const organization = { id: "org", name: "Office", members: [] } as never;
  await act(async () =>
    root.render(
      <AdministrativeOrganizationManager
        action="members"
        organizationId="org"
        workspaceSlug="lab"
        organizations={[organization]}
        onClose={mocks.close}
        onUpdated={async () => {}}
      />
    )
  );
  await openAndSelect();
  interactive(document.querySelector<HTMLSelectElement>("#organization-member-role")!);
  const add = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === "添加成员"
  )!;
  expect(add.disabled).toBe(false);
  interactive(add);
  await act(async () => add.click());
  expect(mocks.addMember).toHaveBeenCalledWith("lab", "org", "user-1", "MEMBER");
});

it("blocks organization members who are already active in the organization", async () => {
  const organization = {
    id: "org",
    name: "Office",
    members: [],
  };
  const renderManager = (members: typeof organization.members) =>
    root.render(
      <AdministrativeOrganizationManager
        action="members"
        organizationId="org"
        workspaceSlug="lab"
        organizations={[{ ...organization, members }] as never}
        onClose={mocks.close}
        onUpdated={async () => {}}
      />
    );
  await act(async () => renderManager(organization.members));
  await openAndSelect();
  await act(async () => renderManager([{ id: "user-1", name: "Alice", email: "alice@example.test", role: "MEMBER" }]));
  const add = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === "添加成员"
  )!;
  await act(async () => add.click());

  expect(mocks.addMember).not.toHaveBeenCalled();
  expect(setToast).toHaveBeenCalledWith({
    type: "warning",
    title: "无法重复添加成员",
    message: "所选成员已在该组织中，请取消选择；如需调整角色，请在成员列表操作。",
  });
});

it("shows the duplicate-member message when the API reports an existing member", async () => {
  mocks.addMember.mockRejectedValueOnce({
    response: {
      data: {
        code: "MEMBER_ALREADY_IN_ORGANIZATION",
        message: "Member is already in this organization.",
      },
    },
  });
  const organization = { id: "org", name: "Office", members: [] };
  await act(async () =>
    root.render(
      <AdministrativeOrganizationManager
        action="members"
        organizationId="org"
        workspaceSlug="lab"
        organizations={[organization] as never}
        onClose={mocks.close}
        onUpdated={async () => {}}
      />
    )
  );
  await openAndSelect();
  const add = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === "添加成员"
  )!;
  await act(async () => add.click());

  expect(mocks.addMember).toHaveBeenCalledExactlyOnceWith("lab", "org", "user-1", "MEMBER");
  expect(setToast).toHaveBeenCalledWith({
    type: "error",
    title: "组织操作失败",
    message: "所选成员已在该组织中，请取消选择；如需调整角色，请在成员列表操作。",
  });
});

it("supports adding mixed-role project members through the real multi-select combobox", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.projectAddMembers.mockResolvedValue([
    { id: "membership-1", member: "admin-user", role: 20 },
    { id: "membership-2", member: "member-user", role: 15 },
    { id: "membership-3", member: "guest-user", role: 5 },
  ]);

  try {
    await act(async () =>
      root.render(<SendProjectInvitationModal isOpen onClose={mocks.close} workspaceSlug="lab" projectId="project" />)
    );

    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="project_settings.members.invite_members.select_co_worker"]'
    )!;
    await act(async () => trigger.click());
    const options = [...document.querySelectorAll<HTMLElement>("[role='option']")];
    expect(options).toHaveLength(3);
    for (const option of options) {
      // oxlint-disable-next-line no-await-in-loop
      await clickOption(option);
    }

    const submit = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "add_members"
    )!;
    expect(submit).toBeTruthy();
    await act(async () => submit.click());

    expect(mocks.projectAddMembers).toHaveBeenCalledExactlyOnceWith("lab", "project", {
      members: [
        { member_id: "admin-user", role: 20 },
        { member_id: "member-user", role: 15 },
        { member_id: "guest-user", role: 5 },
      ],
    });
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});

it("filters project members by all selected tags and keeps manual selections", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.projectAddMembers.mockResolvedValue([
    { id: "membership-guest", member: "guest-user", role: 5 },
    { id: "membership-admin", member: "admin-user", role: 20 },
  ]);

  try {
    await act(async () =>
      root.render(<SendProjectInvitationModal isOpen onClose={mocks.close} workspaceSlug="lab" projectId="project" />)
    );
    await act(async () => undefined);

    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="project_settings.members.invite_members.select_co_worker"]'
    )!;
    await act(async () => trigger.click());
    const guestOption = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((option) =>
      option.textContent?.includes("洪贵春")
    )!;
    await clickOption(guestOption);
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('input[role="combobox"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
    );

    await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='member-tag-tag-core']")?.click());
    await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='member-tag-tag-lead']")?.click());
    expect(container.querySelector("[data-testid='filtered-member-count']")?.textContent).toContain("1");

    await act(async () => trigger.click());
    const searchInput = document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => {
      searchInput.value = "jinshuai0821";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const visibleOptions = [...document.querySelectorAll<HTMLElement>("[role='option']")];
    expect(visibleOptions).toHaveLength(1);
    expect(visibleOptions[0]?.textContent).toContain("金帅 · jinshuai0821");

    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-testid='select-filtered-members']")!.click()
    );
    const roleSelects = container.querySelectorAll<HTMLSelectElement>("select[aria-label='project member role']");
    expect(roleSelects).toHaveLength(2);

    const submit = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "add_members"
    )!;
    await act(async () => submit.click());

    expect(mocks.projectAddMembers).toHaveBeenCalledExactlyOnceWith("lab", "project", {
      members: [
        { member_id: "guest-user", role: 5 },
        { member_id: "admin-user", role: 20 },
      ],
    });
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});

it("keeps workspace search controls accessible while selecting related work items", async () => {
  const issue = {
    id: "issue-1",
    name: "Purchase",
    project_id: "project-1",
    project__identifier: "EQ",
    sequence_id: 1,
  } as never;
  await act(async () =>
    root.render(
      <ExistingIssuesListModal
        isOpen
        workspaceSlug="lab"
        projectId="project-1"
        handleClose={mocks.close}
        handleOnSubmit={mocks.submit}
        searchParams={{}}
        workspaceLevelToggle
        workItemSearchServiceCallback={async () => [issue]}
      />
    )
  );
  await openOptions();
  const toggle = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent === "common.workspace_level"
  )!;
  expect(toggle).toBeDefined();
  interactive(toggle);
});
