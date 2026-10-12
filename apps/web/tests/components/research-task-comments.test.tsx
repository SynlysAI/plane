// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { TResearchChainNodeTask, TResearchTaskComment } from "@plane/types";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  getTaskComments: vi.fn(),
  createTaskComment: vi.fn(),
  updateTaskComment: vi.fn(),
  deleteTaskComment: vi.fn(),
}));
vi.mock("@/services/research/chain-task.service", () => ({
  ResearchChainTaskService: class {
    getTaskComments = mocks.getTaskComments;
    createTaskComment = mocks.createTaskComment;
    updateTaskComment = mocks.updateTaskComment;
    deleteTaskComment = mocks.deleteTaskComment;
  },
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.split(".").reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations) ?? key,
  }),
}));
vi.mock("@makeplane/propel/components/avatar", () => ({ Avatar: () => <span /> }));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, disabled, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
}));
vi.mock("@plane/ui", () => {
  // eslint-disable-next-line unicorn/consistent-function-scoping
  const Menu = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Menu.MenuItem = ({ children, onClick }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick}>{children}</button>
  );
  return { CustomMenu: Menu };
});
vi.mock("@/components/editor/lite-text", () => ({
  LiteTextEditor: React.forwardRef(function Editor(
    {
      initialValue,
      editable,
      placeholder,
      onChange,
    }: {
      initialValue: string;
      editable: boolean;
      placeholder?: string;
      onChange?: (json: object, html: string) => void;
    },
    ref
  ) {
    const [body, setBody] = React.useState(initialValue);
    React.useImperativeHandle(ref, () => ({ clearEditor: () => setBody("<p></p>") }));
    return editable ? (
      <textarea
        aria-label={placeholder ?? "评论编辑器"}
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
          onChange?.({}, event.target.value);
        }}
      />
    ) : (
      <div>{initialValue}</div>
    );
  }),
}));
const { ResearchTaskComments } = await import("@/components/research/chains/research-task-comments");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const task = { id: "task-1", chain: "chain-1", node: "node-1", workspace: "ws-1" } as TResearchChainNodeTask;
const comment: TResearchTaskComment = {
  id: "comment-1",
  task: "task-1",
  actor: "user-1",
  actor_detail: { id: "user-1", display_name: "王老师", avatar_url: null },
  comment_html: "<p>讨论内容</p>",
  comment_stripped: "讨论内容",
  can_edit: true,
  can_delete: true,
  edited_at: null,
  created_at: "2026-10-12T10:00:00Z",
  updated_at: "2026-10-12T10:00:00Z",
};
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getTaskComments.mockResolvedValue({ results: [], can_comment: true });
  mocks.createTaskComment.mockResolvedValue(comment);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});
async function renderTask(nextTask = task) {
  await act(async () =>
    root.render(<ResearchTaskComments task={nextTask} workspaceSlug="lab" locale="zh-CN" order="asc" />)
  );
}
async function click(text: string) {
  await act(async () => {
    const element = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === text);
    if (!element) throw new Error(`No button ${text}`);
    element.click();
  });
}
async function write(html: string) {
  await act(async () => {
    const input = container.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, html);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("retains failed drafts and retries with the same request id, then clears after success", async () => {
  mocks.createTaskComment.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(comment);
  await renderTask();
  await write("<p>讨论内容</p>");
  await click("发表评论");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("输入内容已保留");
  expect(container.querySelector("textarea")?.value).toBe("<p>讨论内容</p>");
  const firstPayload = mocks.createTaskComment.mock.calls[0]?.[4];
  await click("发表评论");
  expect(mocks.createTaskComment.mock.calls[1]?.[4]).toEqual(firstPayload);
  expect(container.querySelector("article")?.textContent).toContain("王老师");
  expect(container.querySelector("textarea")?.value).toBe("<p></p>");
});

it("allows author edit and confirmed deletion without changing the task description", async () => {
  mocks.getTaskComments.mockResolvedValue({ results: [comment], can_comment: false });
  mocks.updateTaskComment.mockResolvedValue({
    ...comment,
    comment_html: "<p>补充后的讨论</p>",
    edited_at: comment.created_at,
  });
  mocks.deleteTaskComment.mockResolvedValue(undefined);
  await renderTask();
  await click("编辑");
  await write("<p>补充后的讨论</p>");
  await click("保存修改");
  expect(mocks.updateTaskComment).toHaveBeenCalledWith(
    "lab",
    "chain-1",
    "node-1",
    "task-1",
    "comment-1",
    "<p>补充后的讨论</p>"
  );
  expect(container.textContent).toContain("已编辑");
  await click("删除");
  expect(mocks.deleteTaskComment).not.toHaveBeenCalled();
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[role="alert"] button:last-of-type')?.click();
  });
  expect(mocks.deleteTaskComment).toHaveBeenCalledWith("lab", "chain-1", "node-1", "task-1", "comment-1");
  expect(container.querySelector("article")).toBeNull();
});

it("shows readonly comments without author controls or a composer", async () => {
  mocks.getTaskComments.mockResolvedValue({
    results: [{ ...comment, can_edit: false, can_delete: false }],
    can_comment: false,
  });
  await renderTask();
  expect(container.textContent).toContain("讨论内容");
  expect(container.querySelector("textarea")).toBeNull();
  expect(container.querySelector("button")).toBeNull();
});

it("ignores a late response from the previously selected task", async () => {
  let resolve!: (value: object) => void;
  mocks.getTaskComments
    .mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    )
    .mockResolvedValue({ results: [], can_comment: true });
  await renderTask();
  await renderTask({ ...task, id: "task-2" });
  await act(async () => resolve({ results: [comment], can_comment: true }));
  expect(container.querySelector("article")).toBeNull();
  await write("<p>第二个任务</p>");
  await click("发表评论");
  expect(mocks.createTaskComment.mock.calls[0]?.[3]).toBe("task-2");
});
