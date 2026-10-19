// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bulkUpdateMemberTags: vi.fn(),
  close: vi.fn(),
  success: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({ workspace: { bulkUpdateMemberTags: mocks.bulkUpdateMemberTags } }),
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { ERROR: "error" },
  setToast: mocks.toast,
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({
    children,
    loading: _loading,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean }) => <button {...props}>{children}</button>,
}));
vi.mock("@makeplane/propel/icons", () => ({ SearchOutline: () => <span aria-hidden="true" /> }));
vi.mock("@plane/ui", () => ({
  ModalCore: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  EModalPosition: { CENTER: "center" },
  EModalWidth: { XXL: "xxl" },
}));

import { BulkMemberTagsEditor } from "@/components/workspace/settings/bulk-member-tags-editor";

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
  },
  {
    id: "membership-2",
    member: {
      id: "member-2",
      display_name: "Bobby",
      first_name: "Bob",
      last_name: "Lin",
      email: "bob@example.com",
    },
  },
  {
    id: "membership-3",
    member: {
      id: "member-3",
      display_name: "Carol Wu",
      first_name: "Carol",
      last_name: "Wu",
      email: "carol@example.com",
    },
  },
] as never[];

const GROUPS = [
  {
    id: "group-1",
    name: "团队",
    sort_order: 1,
    tags: [{ id: "tag-1", group_id: "group-1", name: "核心", color: "sage", sort_order: 1 }],
  },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.bulkUpdateMemberTags.mockResolvedValue([]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <BulkMemberTagsEditor
        workspaceSlug="lab"
        memberIds={["member-1", "member-2", "member-3"]}
        members={MEMBERS}
        groups={GROUPS}
        onClose={mocks.close}
        onSuccess={mocks.success}
      />
    )
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows all selected members and filters only the visible list", async () => {
  expect(container.textContent).toContain("已选择 3 名成员");
  expect(container.textContent).toContain("Alice Chen");
  expect(container.textContent).toContain("bob@example.com");

  await act(async () => {
    const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索已选成员"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "bob@example.com");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });

  expect(container.textContent).toContain("已选择 3 名成员");
  expect(container.querySelector('[data-member-id="member-1"]')).toBeNull();
  expect(container.querySelector('[data-member-id="member-2"]')).not.toBeNull();

  await act(async () => {
    const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索已选成员"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Bob Lin");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector('[data-member-id="member-2"]')).not.toBeNull();

  await act(async () => {
    const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索已选成员"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Bobby");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.querySelector('[data-member-id="member-2"]')).not.toBeNull();
});

it("saves every selected member after the list is filtered", async () => {
  await act(async () => {
    const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索已选成员"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Carol");
    search.dispatchEvent(new Event("input", { bubbles: true }));
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "核心")
      ?.click();
  });

  await act(async () => {
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "添加所选标签")
      ?.click();
  });

  expect(mocks.bulkUpdateMemberTags).toHaveBeenCalledWith("lab", {
    member_ids: ["member-1", "member-2", "member-3"],
    add_tag_ids: ["tag-1"],
    remove_tag_ids: [],
  });
  expect(mocks.success).toHaveBeenCalledOnce();
  expect(mocks.close).toHaveBeenCalledOnce();
});

it("keeps the dialog open and reports an API error", async () => {
  mocks.bulkUpdateMemberTags.mockRejectedValue({ error: "标签表尚未迁移。" });

  await act(async () => {
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "核心")
      ?.click();
  });
  await act(async () => {
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "添加所选标签")
      ?.click();
  });

  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith({
    type: "error",
    title: "保存成员标签失败",
    message: "标签表尚未迁移。",
  });
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
});

it("closes on cancellation without reporting a successful update", async () => {
  await act(async () => {
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "取消")
      ?.click();
  });

  expect(mocks.close).toHaveBeenCalledOnce();
  expect(mocks.success).not.toHaveBeenCalled();
  expect(mocks.bulkUpdateMemberTags).not.toHaveBeenCalled();
});
