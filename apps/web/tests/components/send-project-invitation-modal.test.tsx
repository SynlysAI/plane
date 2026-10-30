// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addMembers: vi.fn(),
  fetchTagGroups: vi.fn(),
  onClose: vi.fn(),
  onSuccess: vi.fn(),
  projectMembers: new Map(),
  tagGroups: [],
  workspaceMembers: new Map(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@plane/propel/button", async () => {
  const React = await import("react");
  return {
    Button: ({
      children,
      loading: _loading,
      size: _size,
      variant: _variant,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement>) => React.createElement("button", props, children),
  };
});

vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "success", ERROR: "error" },
  setToast: vi.fn(),
}));

vi.mock("@makeplane/propel/components/avatar", async () => {
  const React = await import("react");
  return {
    Avatar: ({ fallback }: { fallback?: string }) => React.createElement("span", { "aria-hidden": true }, fallback),
  };
});

vi.mock("@makeplane/propel/icons", async () => {
  const React = await import("react");
  const Icon = () => React.createElement("span", { "aria-hidden": "true" });
  return { ChevronDownOutline: Icon, CloseOutline: Icon, TickOutline: Icon };
});

vi.mock("@plane/ui", async () => {
  const React = await import("react");
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const CustomSelectComponent = ({
    children,
    onChange,
    value,
  }: {
    children: React.ReactNode;
    onChange: (value: string) => void;
    value?: string | number;
  }) =>
    React.createElement(
      "select",
      {
        "aria-label": "project member role",
        value: String(value ?? ""),
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.target.value),
      },
      children
    );
  CustomSelectComponent.Option = ({ value, children }: { value: string; children: React.ReactNode }) =>
    React.createElement("option", { value }, children);

  return {
    EModalPosition: { CENTER: "center" },
    EModalWidth: { XXL: "xxl" },
    ModalCore: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CustomSearchSelect: ({
      multiple,
      onChange,
      options,
      value,
    }: {
      multiple?: boolean;
      onChange: (value: string[]) => void;
      options: { value: string; query: string; content: React.ReactNode }[];
      value: string[];
    }) => (
      <div data-testid="member-search-select">
        <span data-testid="member-select-multiple">{String(Boolean(multiple))}</span>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            data-testid={`select-${option.value}`}
            data-query={option.query}
            onClick={() => onChange(value.includes(option.value) ? value : [...value, option.value])}
          >
            {option.content}
          </button>
        ))}
      </div>
    ),
    CustomSelect: CustomSelectComponent,
  };
});

vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({
    project: {
      getProjectMemberDetails: (memberId: string) => mocks.projectMembers.get(memberId) ?? null,
      bulkAddMembersToProject: mocks.addMembers,
    },
    workspace: {
      fetchWorkspaceMemberTagGroups: mocks.fetchTagGroups,
      workspaceMemberTagGroups: { workspace: mocks.tagGroups },
      workspaceMemberIds: [...mocks.workspaceMembers.keys()],
      getWorkspaceMemberDetails: (memberId: string) => mocks.workspaceMembers.get(memberId),
    },
  }),
}));

vi.mock("@/hooks/store/user", () => ({
  useUserPermissions: () => ({
    getProjectRoleByWorkspaceSlugAndProjectId: () => 20,
  }),
}));

vi.mock("@plane/utils", () => ({
  getFileURL: (url: string) => url,
}));

import { SendProjectInvitationModal } from "@/components/project/send-project-invitation-modal";
import { setToast } from "@plane/propel/toast";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tagGroups.length = 0;
  const teacherTag = { id: "tag-teacher", group_id: "group-role", name: "教师", color: "sage", sort_order: 0 };
  const studentTag = { id: "tag-student", group_id: "group-role", name: "学生", color: "sand", sort_order: 1 };
  const adminTag = { id: "tag-admin", group_id: "group-duty", name: "管理员", color: "mist", sort_order: 0 };
  mocks.tagGroups.push(
    { id: "group-role", name: "身份", sort_order: 0, tags: [teacherTag, studentTag] },
    { id: "group-duty", name: "职责", sort_order: 1, tags: [adminTag] }
  );
  mocks.fetchTagGroups.mockResolvedValue(mocks.tagGroups);

  mocks.projectMembers.clear();
  mocks.workspaceMembers.clear();
  mocks.workspaceMembers.set("alice-account", {
    email: "alice@example.com",
    role: 15,
    tags: [teacherTag, adminTag],
    member: {
      id: "alice-account",
      username: "jinshuai0821",
      first_name: "金",
      last_name: "帅",
      display_name: "jinshuai0821",
      email: "alice@example.com",
      avatar_url: "",
    },
  });
  mocks.workspaceMembers.set("bob-account", {
    email: "bob@example.com",
    role: 15,
    tags: [teacherTag],
    member: {
      id: "bob-account",
      username: "bob.wang",
      first_name: "Bob",
      last_name: "Wang",
      display_name: "Bob Wang",
      email: "bob@example.com",
      avatar_url: "",
    },
  });
  mocks.workspaceMembers.set("carol-account", {
    email: "carol@example.com",
    role: 15,
    tags: [studentTag],
    member: {
      id: "carol-account",
      username: "carol.li",
      first_name: "Carol",
      last_name: "Li",
      display_name: "Carol Li",
      email: "carol@example.com",
      avatar_url: "",
    },
  });
  mocks.workspaceMembers.set("dave-inactive-account", {
    email: "dave@example.com",
    role: 15,
    is_active: false,
    tags: [adminTag],
    member: {
      id: "dave-inactive-account",
      username: "dave.inactive",
      first_name: "Dave",
      last_name: "Inactive",
      display_name: "Dave Inactive",
      email: "dave@example.com",
      avatar_url: "",
    },
  });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("支持按账号和邮箱搜索成员，并一次提交多人及其独立角色", async () => {
  await act(async () =>
    root.render(
      <SendProjectInvitationModal
        isOpen
        onClose={mocks.onClose}
        onSuccess={mocks.onSuccess}
        workspaceSlug="workspace"
        projectId="project"
      />
    )
  );

  expect(container.querySelector("[data-testid='member-select-multiple']")?.textContent).toBe("true");
  expect(container.querySelector("[data-testid='select-alice-account']")?.getAttribute("data-query")).toContain(
    "jinshuai0821"
  );
  expect(container.querySelector("[data-testid='select-alice-account']")?.getAttribute("data-query")).toContain(
    "alice@example.com"
  );
  expect(container.querySelector("[data-testid='select-alice-account']")?.textContent).toContain("金帅 · jinshuai0821");
  expect(container.querySelector("[data-testid='select-alice-account']")?.textContent).toContain("alice@example.com");
  expect(container.querySelector("[data-testid='select-bob-account']")?.textContent?.match(/Bob Wang/g)).toHaveLength(
    1
  );

  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='select-alice-account']")?.click());
  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='select-bob-account']")?.click());

  const roleSelects = container.querySelectorAll<HTMLSelectElement>("select[aria-label='project member role']");
  expect(roleSelects).toHaveLength(2);
  expect(roleSelects[0].value).toBe("15");
  expect(roleSelects[1].value).toBe("15");

  await act(async () => {
    roleSelects[1].value = "20";
    roleSelects[1].dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => {
    container.querySelector("form")?.requestSubmit();
  });

  expect(mocks.addMembers).toHaveBeenCalledWith("workspace", "project", {
    members: [
      { member_id: "alice-account", role: 15 },
      { member_id: "bob-account", role: 20 },
    ],
  });
  expect(mocks.onSuccess).toHaveBeenCalledOnce();
  expect(mocks.onClose).toHaveBeenCalledOnce();
});

it("标签筛选按全部匹配批量选择并保留手动成员与角色", async () => {
  await act(async () =>
    root.render(
      <SendProjectInvitationModal
        isOpen
        onClose={mocks.onClose}
        onSuccess={mocks.onSuccess}
        workspaceSlug="workspace"
        projectId="project"
      />
    )
  );

  // 先手动选择 Bob；随后教师 + 管理员的 AND 筛选只应保留 Alice。
  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='select-bob-account']")?.click());
  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='member-tag-tag-teacher']")?.click());
  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='member-tag-tag-admin']")?.click());

  expect(container.querySelector("[data-testid='select-alice-account']")).not.toBeNull();
  expect(container.querySelector("[data-testid='select-bob-account']")).toBeNull();
  expect(container.querySelector("[data-testid='select-carol-account']")).toBeNull();
  expect(container.querySelector("[data-testid='filtered-member-count']")?.textContent).toContain("1");

  const selectFiltered = container.querySelector<HTMLButtonElement>("[data-testid='select-filtered-members']")!;
  expect(selectFiltered.disabled).toBe(false);
  await act(async () => selectFiltered.click());

  let roleSelects = container.querySelectorAll<HTMLSelectElement>("select[aria-label='project member role']");
  expect(roleSelects).toHaveLength(2);
  expect(Array.from(roleSelects).map((select) => select.value)).toEqual(["15", "15"]);

  // 调整 Bob 的角色后重复批量选择，不得重复成员或覆盖已调整角色。
  await act(async () => {
    roleSelects[0].value = "20";
    roleSelects[0].dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='select-filtered-members']")!.click());

  roleSelects = container.querySelectorAll<HTMLSelectElement>("select[aria-label='project member role']");
  expect(roleSelects).toHaveLength(2);
  expect(roleSelects[0].value).toBe("20");

  await act(async () => {
    container.querySelector("form")?.requestSubmit();
  });
  expect(mocks.addMembers).toHaveBeenCalledExactlyOnceWith("workspace", "project", {
    members: [
      { member_id: "bob-account", role: 20 },
      { member_id: "alice-account", role: 15 },
    ],
  });
});

it("标签筛选为空时禁用批量选择", async () => {
  await act(async () =>
    root.render(
      <SendProjectInvitationModal isOpen onClose={mocks.onClose} workspaceSlug="workspace" projectId="project" />
    )
  );

  const selectFiltered = container.querySelector<HTMLButtonElement>("[data-testid='select-filtered-members']")!;
  expect(selectFiltered.disabled).toBe(true);

  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='member-tag-tag-teacher']")?.click());
  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='member-tag-tag-student']")?.click());
  expect(container.querySelector("[data-testid='filtered-member-count']")?.textContent).toContain("0");
  expect(container.querySelector<HTMLButtonElement>("[data-testid='select-filtered-members']")!.disabled).toBe(true);
});

it("停用成员不进入候选列表和候选数量", async () => {
  await act(async () =>
    root.render(
      <SendProjectInvitationModal isOpen onClose={mocks.onClose} workspaceSlug="workspace" projectId="project" />
    )
  );

  expect(container.querySelector("[data-testid='select-dave-inactive-account']")).toBeNull();
  expect(container.querySelector("[data-testid='filtered-member-count']")?.textContent).toContain("3");

  // 停用成员的标签不参与可添加标签统计。
  expect(container.querySelector<HTMLButtonElement>("[data-testid='member-tag-tag-admin']")).not.toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='member-tag-tag-admin']")?.click());
  expect(container.querySelector("[data-testid='filtered-member-count']")?.textContent).toContain("1");
});

it("已全部添加的标签进入只读分区", async () => {
  const alice = mocks.workspaceMembers.get("alice-account")!;
  mocks.projectMembers.set("alice-account", {
    id: "project-membership-alice",
    member: alice.member,
    role: 15,
    original_role: 15,
    membership_source: "DIRECT",
    inherits_organization: false,
  });

  await act(async () =>
    root.render(
      <SendProjectInvitationModal isOpen onClose={mocks.onClose} workspaceSlug="workspace" projectId="project" />
    )
  );

  expect(container.querySelector<HTMLButtonElement>("[data-testid='member-tag-tag-admin']")).toBeNull();
  expect(container.querySelector("[data-testid='fully-added-tag-tag-admin']")?.textContent).toContain("管理员");
  expect(container.querySelector<HTMLButtonElement>("[data-testid='member-tag-tag-teacher']")).not.toBeNull();
});

it("标签加载失败和无可选标签时保留手动添加能力", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  mocks.fetchTagGroups.mockRejectedValueOnce(new Error("tag groups unavailable"));

  try {
    await act(async () =>
      root.render(
        <SendProjectInvitationModal isOpen onClose={mocks.onClose} workspaceSlug="workspace" projectId="project" />
      )
    );
    await act(async () => undefined);

    expect(container.querySelector("[data-testid='tag-filter-error']")?.textContent).toContain(
      "project_settings.members.tags_load_failed"
    );
    expect(container.querySelector("[data-testid='select-alice-account']")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>("[data-testid='select-filtered-members']")!.disabled).toBe(true);

    await act(async () => root.render(null));
    mocks.fetchTagGroups.mockResolvedValueOnce([]);
    mocks.workspaceMembers.forEach((membership) => {
      membership.tags = [];
    });
    await act(async () =>
      root.render(
        <SendProjectInvitationModal isOpen onClose={mocks.onClose} workspaceSlug="workspace" projectId="project" />
      )
    );
    await act(async () => undefined);

    expect(container.querySelector("[data-testid='no-available-tags']")?.textContent).toContain(
      "project_settings.members.no_available_tags"
    );
    expect(container.querySelector("[data-testid='select-alice-account']")).not.toBeNull();
  } finally {
    consoleError.mockRestore();
  }
});

it("批量添加失败时提示原因并保留已选成员与角色", async () => {
  mocks.addMembers.mockRejectedValueOnce({ error: "You cannot add a user with role lower than the workspace role" });

  await act(async () =>
    root.render(
      <SendProjectInvitationModal
        isOpen
        onClose={mocks.onClose}
        onSuccess={mocks.onSuccess}
        workspaceSlug="workspace"
        projectId="project"
      />
    )
  );

  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='select-alice-account']")?.click());
  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='select-bob-account']")?.click());

  await act(async () => {
    container.querySelector("form")?.requestSubmit();
  });

  expect(mocks.addMembers).toHaveBeenCalledOnce();
  expect(setToast).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "error",
      message: "project_settings.members.role_lower_than_workspace",
    })
  );
  expect(mocks.onSuccess).not.toHaveBeenCalled();
  expect(mocks.onClose).not.toHaveBeenCalled();

  const selectedButtons = container.querySelectorAll("[data-testid^='select-']");
  const roleSelects = container.querySelectorAll<HTMLSelectElement>("select[aria-label='project member role']");
  expect(roleSelects).toHaveLength(2);
  expect(Array.from(roleSelects).map((select) => select.value)).toEqual(["15", "15"]);
  expect(selectedButtons.length).toBeGreaterThan(0);
});

it("优先按结构化错误码提示角色越界，兼容旧版纯文案错误", async () => {
  await act(async () =>
    root.render(
      <SendProjectInvitationModal
        isOpen
        onClose={mocks.onClose}
        onSuccess={mocks.onSuccess}
        workspaceSlug="workspace"
        projectId="project"
      />
    )
  );

  await act(async () => container.querySelector<HTMLButtonElement>("[data-testid='select-alice-account']")?.click());

  // 新版后端返回结构化错误码，即使文案调整也应命中同一条提示。
  mocks.addMembers.mockRejectedValueOnce({
    error_code: "role_higher_than_workspace",
    error: "unrelated message",
  });
  await act(async () => {
    container.querySelector("form")?.requestSubmit();
  });
  expect(setToast).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "error",
      message: "project_settings.members.role_higher_than_workspace",
    })
  );

  // 旧版纯文案错误仍通过子串匹配兜底。
  mocks.addMembers.mockRejectedValueOnce({ error: "You cannot add a user with role lower than the workspace role" });
  await act(async () => {
    container.querySelector("form")?.requestSubmit();
  });
  expect(setToast).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "error",
      message: "project_settings.members.role_lower_than_workspace",
    })
  );

  // 停用工作区成员返回结构化错误，前端不复用泛化失败文案。
  mocks.addMembers.mockRejectedValueOnce({ error_code: "inactive_workspace_member", error: "unrelated message" });
  await act(async () => {
    container.querySelector("form")?.requestSubmit();
  });
  expect(setToast).toHaveBeenLastCalledWith(
    expect.objectContaining({
      type: "error",
      message: "project_settings.members.inactive_workspace_member",
    })
  );
});
