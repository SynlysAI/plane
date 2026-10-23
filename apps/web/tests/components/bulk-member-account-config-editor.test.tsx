// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bulkUpdateMemberAccounts: vi.fn(),
  close: vi.fn(),
  success: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({ workspace: { bulkUpdateMemberAccounts: mocks.bulkUpdateMemberAccounts } }),
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { ERROR: "error", SUCCESS: "success" },
  setToast: mocks.toast,
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({
    children,
    loading: _loading,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => <button {...props}>{children}</button>,
}));
vi.mock("@makeplane/propel/icons", () => ({
  SearchOutline: () => <span aria-hidden="true" />,
}));
vi.mock("@plane/ui", () => ({
  ModalCore: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  EModalPosition: { CENTER: "center" },
  EModalWidth: { XXL: "xxl" },
}));

const { BulkMemberAccountConfigEditor } =
  await import("@/components/workspace/settings/bulk-member-account-config-editor");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

const MEMBERS = [
  {
    id: "membership-1",
    member: {
      id: "member-1",
      display_name: "Alice Chen",
      first_name: "Alice",
      last_name: "Chen",
      email: "alice@example.com",
    },
    role: 15,
    is_active: true,
    is_operations_account: false,
  },
  {
    id: "membership-2",
    member: {
      id: "member-2",
      display_name: "Bob Lin",
      first_name: "Bob",
      last_name: "Lin",
      email: "bob@example.com",
    },
    role: 15,
    is_active: true,
    is_operations_account: true,
  },
  {
    id: "membership-3",
    member: {
      id: "member-3",
      display_name: "Admin User",
      first_name: "Admin",
      last_name: "User",
      email: "admin@example.com",
    },
    role: 20,
    is_active: true,
    is_operations_account: false,
  },
] as never[];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** Render the account configuration dialog with an explicit member selection. */
async function renderEditor(members: unknown = MEMBERS) {
  if (!container) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }
  await act(async () =>
    root.render(
      <BulkMemberAccountConfigEditor
        workspaceSlug="lab"
        memberIds={MEMBERS.map((member) => (member as { member: { id: string } }).member.id)}
        members={members as never}
        onClose={mocks.close}
        onSuccess={mocks.success}
      />
    )
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  container = undefined as unknown as HTMLDivElement;
  root = undefined as unknown as ReturnType<typeof createRoot>;
  mocks.bulkUpdateMemberAccounts.mockResolvedValue([]);
  await renderEditor();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows mixed account states and blocks ineligible members", async () => {
  expect(container.textContent).toContain("已选择 3 名成员");
  expect(container.textContent).toContain("运维账号：1 名");
  expect(container.textContent).toContain("普通成员：1 名");
  expect(container.textContent).toContain("不可配置：1 名");
  expect(container.textContent).toContain("将影响 1 人，1 人保持不变");

  const submit = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === "确认设置"
  )!;
  expect(submit.disabled).toBe(true);
  expect(container.querySelector('[data-member-id="member-3"]')?.textContent).toContain("管理员，不可配置");
});

it("submits all selected eligible member IDs and reports success", async () => {
  await renderEditor(MEMBERS.slice(0, 2));
  await act(async () => {
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "取消运维")
      ?.click();
  });
  expect(container.textContent).toContain("确认取消");
  await act(async () => {
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "确认取消")
      ?.click();
  });

  expect(mocks.bulkUpdateMemberAccounts).toHaveBeenCalledWith("lab", {
    member_ids: ["member-1", "member-2", "member-3"],
    is_operations_account: false,
  });
  expect(mocks.success).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
});

it("keeps the dialog open and reports an API error", async () => {
  await renderEditor(MEMBERS.slice(0, 2));
  mocks.bulkUpdateMemberAccounts.mockRejectedValue({ error: "存在不可配置成员。" });

  await act(async () => {
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "确认设置")
      ?.click();
  });

  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith({
    type: "error",
    title: "账号配置失败",
    message: "存在不可配置成员。",
  });
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
});
