// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/navigation", () => ({ useParams: () => ({ workspaceSlug: "lab" }) }));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { ERROR: "error" },
  setToast: vi.fn(),
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));
vi.mock("@plane/propel/table", () => ({
  Table: ({ columns, data }: { columns?: { tdRender?: (row: unknown) => React.ReactNode }[]; data?: unknown[] }) => (
    <table>
      <tbody>
        {(data ?? []).map((row) => (
          <tr key={String(row)}>
            {(columns ?? []).map((column) => (
              <td key={String(column)}>{column.tdRender?.(row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));
vi.mock("@plane/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  renderFormattedDate: (value: string) => value,
}));
vi.mock("@/components/project/member-header-column", () => ({ MemberHeaderColumn: () => <span /> }));
vi.mock("@/components/workspace/settings/member-columns", () => ({
  AccountTypeColumn: () => <span />,
  NameColumn: () => <span />,
}));
vi.mock("@/components/workspace/settings/member-tags-editor", () => ({ MemberTagsEditor: () => <div /> }));
vi.mock("@/components/ui/loader/layouts/members-layout-loader", () => ({ MembersLayoutLoader: () => <div /> }));
vi.mock("@/components/workspace/confirm-workspace-member-remove", () => ({
  ConfirmWorkspaceMemberRemove: () => <div />,
}));
vi.mock("@/components/workspace/settings/password-reset-modal", () => ({
  WorkspacePasswordResetModal: () => <div />,
}));
vi.mock("@/components/workspace/settings/bulk-member-tags-editor", () => ({ BulkMemberTagsEditor: () => <div /> }));
vi.mock("@/components/workspace/settings/bulk-member-account-config-editor", () => ({
  BulkMemberAccountConfigEditor: () => <div role="dialog">账号配置面板</div>,
}));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({
    workspace: {
      filtersStore: { filters: {}, updateFilters: vi.fn() },
      workspaceMemberTagGroups: {
        lab: [
          {
            id: "group-1",
            name: "研究分工",
            sort_order: 1,
            tags: [],
          },
        ],
      },
      getWorkspaceMemberDetails: vi.fn(),
      removeMemberFromWorkspace: vi.fn(),
    },
  }),
}));
vi.mock("@/hooks/store/user", () => ({
  useUser: () => ({ data: { id: "admin-user" } }),
  useUserPermissions: () => ({ allowPermissions: () => true }),
  useUserSettings: () => ({ fetchCurrentUserSettings: vi.fn() }),
}));
vi.mock("@/hooks/store/use-workspace", () => ({ useWorkspace: () => ({ getWorkspaceRedirectionUrl: () => "/" }) }));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: vi.fn() }) }));

const { WorkspaceMembersListItem } = await import("@/components/workspace/settings/members-list-item");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

function createMember(tags: { id: string; group_id: string; name: string; color: string; sort_order: number }[]) {
  return {
    id: "membership-1",
    member: {
      id: "member-1",
      display_name: "Alice Chen",
      first_name: "Alice",
      last_name: "Chen",
      email: "alice@example.com",
    },
    role: 20,
    is_active: true,
    tags,
  };
}

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
  vi.clearAllMocks();
});

it("renders top-level member tags by group and expands hidden tags", async () => {
  const tags = [1, 2, 3, 4].map((index) => ({
    id: `tag-${index}`,
    group_id: "group-1",
    name: `标签 ${index}`,
    color: "sage",
    sort_order: index,
  }));
  await act(async () => root.render(<WorkspaceMembersListItem memberDetails={[createMember(tags)]} />));

  expect(container.textContent).toContain("研究分工");
  expect(container.textContent).toContain("标签 1");
  expect(container.textContent).toContain("标签 3");
  expect(container.textContent).not.toContain("标签 4");
  expect(container.textContent).toContain("+1");

  await act(async () => {
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "+1")
      ?.click();
  });
  expect(container.textContent).toContain("标签 4");
});

it("shows saved tags immediately when the cached member is re-rendered", async () => {
  await act(async () => root.render(<WorkspaceMembersListItem memberDetails={[createMember([])]} />));
  expect(container.textContent).toContain("—");

  const savedTags = [{ id: "tag-saved", group_id: "group-1", name: "保存后标签", color: "mist", sort_order: 1 }];
  await act(async () => root.render(<WorkspaceMembersListItem memberDetails={[createMember(savedTags)]} />));

  expect(container.textContent).toContain("保存后标签");
});

it("opens the account configuration panel from the member bulk action bar", async () => {
  await act(async () => root.render(<WorkspaceMembersListItem memberDetails={[createMember([])]} />));

  await act(async () => {
    container.querySelector<HTMLInputElement>('input[aria-label="选择 Alice Chen"]')?.click();
  });

  expect(container.textContent).toContain("已选择 1 名成员");
  const accountButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === "账号配置"
  );
  expect(accountButton).not.toBeNull();

  await act(async () => accountButton?.click());

  expect(container.textContent).toContain("账号配置面板");
});
