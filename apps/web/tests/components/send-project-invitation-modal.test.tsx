// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addMembers: vi.fn(),
  onClose: vi.fn(),
  onSuccess: vi.fn(),
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
  TOAST_TYPE: { SUCCESS: "success" },
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
  return { ChevronDownOutline: Icon, CloseOutline: Icon };
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
      getProjectMemberDetails: () => null,
      bulkAddMembersToProject: mocks.addMembers,
    },
    workspace: {
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

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.workspaceMembers.clear();
  mocks.workspaceMembers.set("alice-account", {
    email: "alice@example.com",
    role: 15,
    member: {
      id: "alice-account",
      username: "alice.chen",
      first_name: "Alice",
      last_name: "Chen",
      display_name: "Alice Chen",
      email: "alice@example.com",
      avatar_url: "",
    },
  });
  mocks.workspaceMembers.set("bob-account", {
    email: "bob@example.com",
    role: 15,
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
    "alice.chen"
  );
  expect(container.querySelector("[data-testid='select-alice-account']")?.getAttribute("data-query")).toContain(
    "alice@example.com"
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
