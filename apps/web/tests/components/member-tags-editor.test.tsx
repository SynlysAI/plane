// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  toast: vi.fn(),
  updateMemberTags: vi.fn(),
}));

vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({ workspace: { updateMemberTags: mocks.updateMemberTags } }),
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
vi.mock("@makeplane/propel/icons", () => ({
  TickOutline: () => <span data-testid="member-tag-tick" aria-hidden="true" />,
}));
vi.mock("@plane/ui", () => ({
  ModalCore: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
  EModalPosition: { CENTER: "center" },
  EModalWidth: { XXL: "xxl" },
}));

const { MemberTagsEditor } = await import("@/components/workspace/settings/member-tags-editor");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

const GROUPS = [
  {
    id: "group-1",
    name: "研究分工",
    sort_order: 1,
    tags: [
      { id: "tag-selected", group_id: "group-1", name: "已选标签", color: "sage", sort_order: 1 },
      { id: "tag-unselected", group_id: "group-1", name: "未选标签", color: "sand", sort_order: 2 },
    ],
  },
] as never[];

const SELECTED_TAGS = [{ id: "tag-selected", group_id: "group-1", name: "已选标签", color: "sage", sort_order: 1 }];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderEditor() {
  return act(async () =>
    root.render(
      <MemberTagsEditor
        workspaceSlug="lab"
        memberId="member-1"
        memberName="Alice Chen"
        groups={GROUPS}
        selectedTags={SELECTED_TAGS}
        onClose={mocks.close}
      />
    )
  );
}

function findTagButton(name: string) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === name
  )!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMemberTags.mockResolvedValue(SELECTED_TAGS);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("shows the member's existing tags as selected", async () => {
  await renderEditor();

  const selectedButton = findTagButton("已选标签");
  const unselectedButton = findTagButton("未选标签");

  expect(container.textContent).toContain("已选标签：1 个");
  expect(selectedButton.getAttribute("aria-pressed")).toBe("true");
  expect(selectedButton.querySelector('[data-testid="member-tag-tick"]')).not.toBeNull();
  expect(unselectedButton.getAttribute("aria-pressed")).toBe("false");
  expect(unselectedButton.querySelector('[data-testid="member-tag-tick"]')).toBeNull();
});

it("updates selection state and count when tags are toggled", async () => {
  await renderEditor();

  await act(async () => findTagButton("已选标签").click());
  expect(findTagButton("已选标签").getAttribute("aria-pressed")).toBe("false");
  expect(container.textContent).toContain("已选标签：0 个");

  await act(async () => findTagButton("未选标签").click());
  expect(findTagButton("未选标签").getAttribute("aria-pressed")).toBe("true");
  expect(findTagButton("未选标签").querySelector('[data-testid="member-tag-tick"]')).not.toBeNull();
  expect(container.textContent).toContain("已选标签：1 个");
});

it("submits the selected tag ids", async () => {
  await renderEditor();

  await act(async () => findTagButton("未选标签").click());
  await act(async () => findTagButton("保存标签").click());

  expect(mocks.updateMemberTags).toHaveBeenCalledWith("lab", "member-1", ["tag-selected", "tag-unselected"]);
  expect(mocks.close).toHaveBeenCalledOnce();
});

it("keeps the dialog open when saving fails", async () => {
  mocks.updateMemberTags.mockRejectedValue({ error: "标签表尚未迁移。" });
  await renderEditor();

  await act(async () => findTagButton("保存标签").click());

  expect(mocks.close).not.toHaveBeenCalled();
  expect(mocks.toast).toHaveBeenCalledWith({
    type: "error",
    title: "保存成员标签失败",
    message: "标签表尚未迁移。",
  });
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
});
