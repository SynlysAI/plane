// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TResearchChainNodeTask } from "@plane/types";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  getNodeTasks: vi.fn(),
  getAssignableUsers: vi.fn(),
  createNodeTask: vi.fn(),
  updateNodeTask: vi.fn(),
  runNodeTaskAction: vi.fn(),
  getNotificationRecipients: vi.fn(),
  updateNotificationRecipients: vi.fn(),
  updateNotificationSelfSubscription: vi.fn(),
}));
const capturedDescription = vi.hoisted(() => ({ props: null as null | { editable: boolean; value: string } }));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      return typeof value === "string" ? value : key;
    },
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@/services/research/chain-task.service", () => ({
  ResearchChainTaskService: class {
    getNodeTasks = mocks.getNodeTasks;
    getAssignableUsers = mocks.getAssignableUsers;
    createNodeTask = mocks.createNodeTask;
    updateNodeTask = mocks.updateNodeTask;
    runNodeTaskAction = mocks.runNodeTaskAction;
    getNotificationRecipients = mocks.getNotificationRecipients;
    updateNotificationRecipients = mocks.updateNotificationRecipients;
    updateNotificationSelfSubscription = mocks.updateNotificationSelfSubscription;
  },
}));

vi.mock("@/components/research/chains/research-task-comments", () => ({
  ResearchTaskComments: () => <section aria-label="评论">评论</section>,
}));
vi.mock("@/components/research/chains/research-task-description", () => ({
  ResearchTaskDescription: (props: { editable: boolean; value: string; onChange: (value: string) => void }) => {
    capturedDescription.props = props;
    return props.editable ? (
      <textarea
        aria-label="任务说明"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        data-testid="research-description-editor"
      />
    ) : (
      <div data-testid="research-description-view">{props.value || "暂无任务说明"}</div>
    );
  },
}));

const capability = (allowed: boolean) => ({ allowed, reason_code: "", reason: "" });

function task(overrides: Partial<TResearchChainNodeTask> = {}): TResearchChainNodeTask {
  return {
    schema_version: "research-node-task.v1",
    id: "task-1",
    workspace: "ws",
    chain: "chain-1",
    node: "node-1",
    title: "整理开题文献",
    instruction: "补充近三年实验方法对比。",
    instruction_attachments: [],
    status: "SUBMITTED",
    assignee: "student-1",
    assignee_is_valid: true,
    assignee_detail: { id: "student-1", display_name: "李同学" },
    assigned_by: "advisor-1",
    assigned_by_detail: { id: "advisor-1", display_name: "王导师" },
    due_at: "2026-10-20T00:00:00Z",
    submitted_at: "2026-10-09T08:00:00Z",
    completed_at: null,
    return_reason: "实验样本说明不足",
    resource_type: "NONE",
    resource_id: null,
    request_id: "request-1",
    capabilities: {
      schema_version: "research-capabilities.v1",
      actions: {
        view: capability(true),
        edit: capability(true),
        assign: capability(true),
        submit: capability(false),
        return: capability(true),
        complete: capability(true),
        cancel: capability(false),
      },
    },
    created_at: "2026-10-08T08:00:00Z",
    updated_at: "2026-10-09T08:00:00Z",
    ...overrides,
  };
}

const candidates = [
  {
    user_id: "student-1",
    display_name: "李同学",
    org_unit_id: "unit-1",
    org_unit_name: "智能材料组",
    org_role: "REVIEWER" as const,
    is_primary: true,
    scope: "ORG_SCOPE" as const,
  },
  {
    user_id: "advisor-1",
    display_name: "王导师",
    org_unit_id: "unit-2",
    org_unit_name: "外部导师组",
    org_role: "ADVISOR" as never,
    is_primary: false,
    scope: "COLLABORATOR" as const,
  },
];

const notificationRecipients = {
  schema_version: "task-notification-recipients.v1" as const,
  groups: [{ id: "unit-1", name: "智能材料组" }],
  candidates: [
    {
      id: "student-1",
      display_name: "李同学",
      email: "student@example.com",
      avatar_url: null,
      group_ids: ["unit-1"],
    },
    {
      id: "advisor-1",
      display_name: "王导师",
      email: "advisor@example.com",
      avatar_url: null,
      group_ids: ["unit-1"],
    },
  ],
  selected_user_ids: ["student-1"],
  cc_user_ids: [],
  fixed_user_ids: ["student-1"],
  recipient_user_ids: ["student-1"],
  current_user_subscribed: false,
  current_user_self_subscribed: false,
  can_manage: true,
};

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.getNodeTasks.mockResolvedValue([task()]);
  mocks.getAssignableUsers.mockResolvedValue(candidates);
  mocks.getNotificationRecipients.mockResolvedValue(notificationRecipients);
  mocks.updateNotificationRecipients.mockResolvedValue(notificationRecipients);
  mocks.updateNotificationSelfSubscription.mockResolvedValue(notificationRecipients);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderPanel(initialTaskId?: string) {
  const { ResearchChainTaskPanel } = await import("@/components/research/chains/research-chain-task-panel");
  await act(async () => {
    root.render(
      <ResearchChainTaskPanel workspaceSlug="lab" chainId="chain-1" nodeId="node-1" initialTaskId={initialTaskId} />
    );
  });
  await act(async () => undefined);
}

function button(label: string) {
  const buttons = [...container.querySelectorAll("button")];
  for (let index = buttons.length - 1; index >= 0; index -= 1) {
    if (buttons[index]?.textContent === label) return buttons[index];
  }
  throw new Error(`button ${label} not found`);
}

/** Get the main-content edit toggle inside the opened task peek. */
function editToggle() {
  const toggle = container.querySelector<HTMLButtonElement>("[data-task-edit-toggle]");
  if (!toggle) throw new Error("task edit toggle not found");
  return toggle;
}

it("opens a valid deep-linked research task after tasks load", async () => {
  await renderPanel("task-1");

  const peek = container.querySelector("aside");
  expect(peek?.querySelector("h2")?.textContent).toBe("整理开题文献");
  expect(editToggle().getAttribute("aria-pressed")).toBe("false");
});

it("ignores a deep-linked research task that does not belong to the node", async () => {
  await renderPanel("missing-task");

  expect(container.querySelector("aside")).toBeNull();
});

async function setInput(selector: string, value: string) {
  const input = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 在面板内部触发一次菜单外部点击，并等待延迟关闭回调。 */
async function clickOutsideMenu(target: Element) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

it("opens an existing research task read-only until editing is explicitly enabled", async () => {
  await renderPanel();
  await act(async () => button("整理开题文献").click());

  const peek = container.querySelector("aside");
  expect(peek?.querySelector("h2")?.textContent).toBe("整理开题文献");
  expect(peek?.querySelector('input[aria-label="标题"]')).toBeNull();
  expect(peek?.querySelector('[data-testid="research-description-editor"]')).toBeNull();
  expect(peek?.querySelector('[data-testid="research-description-view"]')?.textContent).toContain(
    "补充近三年实验方法对比。"
  );
  expect(editToggle().textContent).toBe("编辑");
  expect(editToggle().getAttribute("aria-pressed")).toBe("false");
});

it("shows and saves notification members inside the research task peek", async () => {
  await renderPanel();
  await act(async () => button("整理开题文献").click());

  expect(mocks.getNotificationRecipients).toHaveBeenCalledWith("lab", "chain-1", "node-1", "task-1");
  expect(container.querySelector("[data-task-notification-recipients]")?.textContent).toContain("这些人会收到通知");

  await act(async () => button("编辑通知列表").click());
  const selectable = document.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)');
  if (!selectable) throw new Error("selectable notification member not found");
  await act(async () => selectable.click());
  const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === "保存");
  if (!save) throw new Error("notification member save button not found");
  await act(async () => save.click());

  expect(mocks.updateNotificationRecipients).toHaveBeenCalledWith("lab", "chain-1", "node-1", "task-1", [
    "student-1",
    "advisor-1",
  ]);
});

it("saves changed title and instruction together when leaving task edit mode", async () => {
  mocks.updateNodeTask.mockResolvedValue(task({ title: "整理开题文献与实验记录", instruction: "请补充实验记录。" }));
  await renderPanel();
  await act(async () => button("整理开题文献").click());
  await act(async () => editToggle().click());

  expect(editToggle().textContent).toBe("完成");
  expect(editToggle().getAttribute("aria-pressed")).toBe("true");
  await setInput('aside input[aria-label="标题"]', "整理开题文献与实验记录");
  await act(async () => capturedDescription.props?.onChange("请补充实验记录。"));
  await act(async () => editToggle().click());

  expect(mocks.updateNodeTask).toHaveBeenCalledTimes(1);
  expect(mocks.updateNodeTask).toHaveBeenCalledWith("lab", "chain-1", "node-1", "task-1", {
    title: "整理开题文献与实验记录",
    instruction: "请补充实验记录。",
  });
  expect(container.querySelector("aside")?.querySelector('input[aria-label="标题"]')).toBeNull();
  expect(container.querySelector("aside")?.textContent).toContain("整理开题文献与实验记录");
});

it("keeps research description attachment and upload state synchronized with the peek", async () => {
  await renderPanel();
  await act(async () => button("整理开题文献").click());

  const descriptionProps = capturedDescription.props as unknown as {
    onAttachmentsChange: (
      attachments: { id: string; name: string; type: string; size: number; download_url: string }[]
    ) => void;
    onBusyChange: (busy: boolean) => void;
    task: { instruction_attachments: unknown[] };
  };
  await act(async () => {
    descriptionProps.onAttachmentsChange([
      { id: "asset-1", name: "过程说明.pdf", type: "application/pdf", size: 128, download_url: "/download/" },
    ]);
  });
  const synchronizedDescriptionProps = capturedDescription.props as unknown as {
    task: { instruction_attachments: unknown[] };
  };
  expect(synchronizedDescriptionProps.task.instruction_attachments).toHaveLength(1);

  await act(async () => editToggle().click());
  const editableDescriptionProps = capturedDescription.props as unknown as { onBusyChange: (busy: boolean) => void };
  await act(async () => editableDescriptionProps.onBusyChange(true));
  expect(editToggle().disabled).toBe(true);
  await act(async () => editableDescriptionProps.onBusyChange(false));
  expect(editToggle().disabled).toBe(false);
});

it("keeps the task editor open when the title is empty or saving fails", async () => {
  await renderPanel();
  await act(async () => button("整理开题文献").click());
  await act(async () => editToggle().click());
  await setInput('aside input[aria-label="标题"]', "");
  await act(async () => editToggle().click());

  expect(mocks.updateNodeTask).not.toHaveBeenCalled();
  expect(container.querySelector('aside input[aria-label="标题"]')).not.toBeNull();
  expect(container.textContent).toContain("请先填写任务标题。");

  await setInput('aside input[aria-label="标题"]', "整理开题文献与实验记录");
  mocks.updateNodeTask.mockRejectedValueOnce({ error: "title is rejected" });
  await act(async () => editToggle().click());

  expect(mocks.updateNodeTask).toHaveBeenCalledTimes(1);
  expect(mocks.updateNodeTask).toHaveBeenCalledWith("lab", "chain-1", "node-1", "task-1", {
    title: "整理开题文献与实验记录",
  });
  expect(container.querySelector('aside input[aria-label="标题"]')).not.toBeNull();
  expect(container.textContent).toContain("title is rejected");
});

it("hides the edit toggle but keeps permitted property and workflow actions available", async () => {
  const readOnlyTask = task();
  readOnlyTask.capabilities!.actions.edit = capability(false);
  mocks.getNodeTasks.mockResolvedValue([readOnlyTask]);
  await renderPanel();
  await act(async () => button("整理开题文献").click());

  const peek = container.querySelector("aside");
  expect(peek?.querySelector("[data-task-edit-toggle]")).toBeNull();
  expect(peek?.querySelector('button[aria-label="责任人"]')).not.toBeNull();
  expect(peek?.textContent).toContain("退回");
  expect(peek?.textContent).toContain("完成");
});

it("resets edit mode when switching from one research task to another", async () => {
  const second = task({ id: "task-2", title: "补充实验记录", instruction: "请补充实验记录。" });
  mocks.getNodeTasks.mockResolvedValue([task(), second]);
  await renderPanel();
  await act(async () => button("整理开题文献").click());
  await act(async () => editToggle().click());
  expect(container.querySelector('aside input[aria-label="标题"]')).not.toBeNull();

  await act(async () => button("补充实验记录").click());
  expect(editToggle().textContent).toBe("编辑");
  expect(container.querySelector("aside")?.querySelector('input[aria-label="标题"]')).toBeNull();
  expect(container.querySelector("aside")?.textContent).toContain("请补充实验记录。");
});

it("shows task metadata, status text, scoped candidates, and the return reason", async () => {
  await renderPanel();

  expect(container.textContent).toContain("整理开题文献");
  expect(container.textContent).toContain("李同学");
  expect(container.textContent).toContain("2026/10/20");
  expect(container.textContent).toContain("已提交");
  expect(container.textContent).toContain("SUBMITTED");
  expect(container.textContent).not.toContain("实验样本说明不足");

  await act(async () => button("整理开题文献").click());
  const peek = container.querySelector("aside");
  expect(peek?.className).toContain("md:w-1/2");
  expect(peek?.textContent).toContain("属性");
  expect(peek?.textContent).toContain("活动");
  expect(peek?.textContent).toContain("评论");
  expect(peek?.textContent).toContain("补充近三年实验方法对比。");
  expect(peek?.textContent).toContain("王导师");
  expect(peek?.textContent).toContain("2026/10/9");
  expect(peek?.textContent).toContain("实验样本说明不足");

  const assignee = container.querySelector('button[aria-label="责任人"]') as HTMLButtonElement;
  await act(async () => assignee.click());
  const groups = [...container.querySelectorAll('[role="group"]')];
  expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(["组织范围", "显式协作者"]);
  expect(groups[0]?.textContent).toContain("智能材料组");
  expect(groups[0]?.textContent).toContain("评审人");
  expect(groups[1]?.textContent).toContain("外部导师组");
  expect([...container.querySelectorAll('[role="option"]')].some((option) => option.textContent === "未指派")).toBe(
    false
  );
  expect(container.querySelector('[role="combobox"]')).toBeNull();
});

it("uses the administrative peek pattern for an empty research instruction", async () => {
  mocks.getNodeTasks.mockResolvedValue([task({ instruction: "", return_reason: null })]);
  await renderPanel();
  await act(async () => button("整理开题文献").click());
  const peek = container.querySelector("aside");
  expect(peek?.textContent).toContain("暂无任务说明");
  expect(peek?.textContent).not.toContain("添加责任人");
  expect(peek?.textContent).not.toContain("添加截止时间");
  expect(peek?.textContent).toContain("创建了任务");
});

it("keeps task requests scoped to the selected node supplied by the detail container", async () => {
  const { ResearchChainTaskPanel } = await import("@/components/research/chains/research-chain-task-panel");
  await act(async () => {
    root.render(<ResearchChainTaskPanel workspaceSlug="lab" chainId="chain-1" nodeId="node-1" />);
  });
  await act(async () => undefined);
  await act(async () => {
    root.render(<ResearchChainTaskPanel workspaceSlug="lab" chainId="chain-1" nodeId="node-2" />);
  });
  await act(async () => undefined);

  expect(mocks.getNodeTasks).toHaveBeenNthCalledWith(1, "lab", "chain-1", "node-1");
  expect(mocks.getNodeTasks).toHaveBeenNthCalledWith(2, "lab", "chain-1", "node-2");
  expect(mocks.getAssignableUsers).toHaveBeenNthCalledWith(1, "lab", "chain-1");
  expect(mocks.getAssignableUsers).toHaveBeenNthCalledWith(2, "lab", "chain-1");
});

it("creates a task using only a candidate returned by assignable-users", async () => {
  const created = task({
    id: "task-2",
    title: "补充实验记录",
    status: "ASSIGNED",
    return_reason: null,
    capabilities: undefined,
  });
  mocks.createNodeTask.mockResolvedValue(created);
  await renderPanel();

  await act(async () => button("+ 创建任务").click());
  expect(container.querySelector("[data-task-edit-toggle]")).toBeNull();
  expect(container.querySelector('input[aria-label="标题"]')).not.toBeNull();
  await setInput('input:not([type="date"]):not([type="search"])', "补充实验记录");
  await act(async () => button("更多").click());
  const assigneeButtons = [...container.querySelectorAll('button[aria-label="责任人"]')];
  await act(async () => assigneeButtons.at(-1)?.click());
  const option = [...container.querySelectorAll('[role="option"]')].find((item) =>
    item.textContent?.includes("李同学")
  );
  await act(async () => option?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await act(async () => button("创建任务").click());

  expect(mocks.createNodeTask).toHaveBeenCalledWith(
    "lab",
    "chain-1",
    "node-1",
    expect.objectContaining({ title: "补充实验记录", assignee: "student-1" })
  );
  expect(container.textContent).toContain("已指派");
});

it("requires and submits a return reason", async () => {
  mocks.runNodeTaskAction.mockResolvedValue(task({ status: "NEEDS_REVISION", return_reason: "请补充样本信息" }));
  await renderPanel();

  await act(async () => button("已提交").click());
  await act(async () => button("退回").click());
  await act(async () => button("确认提交").click());
  expect(mocks.runNodeTaskAction).not.toHaveBeenCalled();
  expect(container.textContent).toContain("请先填写原因。");

  await setInput("textarea", "请补充样本信息");
  await act(async () => button("确认提交").click());
  expect(mocks.runNodeTaskAction).toHaveBeenCalledWith("lab", "chain-1", "node-1", "task-1", "return", {
    reason: "请补充样本信息",
  });
  expect(container.textContent).toContain("需修订");
});

it("cancels row date and status menus after clicking elsewhere without invoking APIs", async () => {
  await renderPanel();
  const panelHeading = container.querySelector("h3");
  if (!panelHeading) throw new Error("任务面板标题未找到");

  const dateButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
    item.textContent?.includes("2026/10/20")
  );
  if (!dateButton) throw new Error("截止日期按钮未找到");
  await act(async () => dateButton.click());
  expect(container.querySelector('input[type="date"]')).not.toBeNull();

  await clickOutsideMenu(panelHeading);
  expect(container.querySelector('input[type="date"]')).toBeNull();
  expect(mocks.updateNodeTask).not.toHaveBeenCalled();

  await act(async () => button("已提交").click());
  expect([...container.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === "退回")).toBe(true);

  await clickOutsideMenu(panelHeading);
  expect(container.querySelector('[role="menu"]')).toBeNull();
  expect(mocks.runNodeTaskAction).not.toHaveBeenCalled();
});

it("cancels peek layout and more menus without closing the task peek", async () => {
  await renderPanel();
  await act(async () => button("整理开题文献").click());
  const peek = container.querySelector("aside");
  const peekTitle = peek?.querySelector("h2");
  if (!peek || !peekTitle) throw new Error("任务 Peek 标题未找到");

  const layout = peek.querySelector<HTMLButtonElement>('button[aria-label="切换预览布局"]');
  if (!layout) throw new Error("预览布局按钮未找到");
  await act(async () => layout.click());
  expect(peek.querySelector('[role="menu"]')).not.toBeNull();

  await clickOutsideMenu(peekTitle);
  expect(peek.querySelector('[role="menu"]')).toBeNull();
  expect(container.querySelector("aside")).not.toBeNull();

  const more = peek.querySelector<HTMLButtonElement>('button[aria-label="更多"]');
  if (!more) throw new Error("更多按钮未找到");
  await act(async () => more.click());
  expect(peek.querySelector('[role="menu"]')).not.toBeNull();

  await clickOutsideMenu(peekTitle);
  expect(peek.querySelector('[role="menu"]')).toBeNull();
  expect(container.querySelector("aside")).not.toBeNull();
  expect(mocks.runNodeTaskAction).not.toHaveBeenCalled();

  const status = peek.querySelector<HTMLButtonElement>('button[aria-label="状态"]');
  if (!status) throw new Error("Peek 状态按钮未找到");
  await act(async () => status.click());
  expect(peek.querySelector('[role="menu"]')).not.toBeNull();

  await clickOutsideMenu(peekTitle);
  expect(peek.querySelector('[role="menu"]')).toBeNull();
  expect(container.querySelector("aside")).not.toBeNull();
  expect(mocks.runNodeTaskAction).not.toHaveBeenCalled();

  const dueDate = peek.querySelector<HTMLButtonElement>('button[aria-label="截止时间"]');
  if (!dueDate) throw new Error("Peek 截止时间按钮未找到");
  await act(async () => dueDate.click());
  expect(peek.querySelector('input[type="date"]')).not.toBeNull();

  await clickOutsideMenu(peekTitle);
  expect(peek.querySelector('input[type="date"]')).toBeNull();
  expect(container.querySelector("aside")).not.toBeNull();
  expect(mocks.updateNodeTask).not.toHaveBeenCalled();
});

it("keeps task cancellation in the header menu and requires a reason before cancelling", async () => {
  const draft = task({ status: "DRAFT", instruction: "", return_reason: null });
  draft.capabilities!.actions.return = capability(false);
  draft.capabilities!.actions.complete = capability(false);
  draft.capabilities!.actions.cancel = capability(true);
  mocks.getNodeTasks.mockResolvedValue([draft]);
  mocks.runNodeTaskAction.mockResolvedValue(task({ status: "CANCELLED", capabilities: undefined }));
  await renderPanel();
  await act(async () => button("整理开题文献").click());

  const peek = container.querySelector("aside");
  expect(peek?.textContent).not.toContain("取消任务");
  expect(peek?.textContent).not.toContain("MCP / Agent 操作");
  expect(peek?.querySelector('a[href*="/mcp/"]')).toBeNull();
  const more = peek?.querySelector<HTMLButtonElement>('button[aria-label="更多"]');
  expect(more).not.toBeNull();
  await act(async () => more?.click());
  const cancel = peek?.querySelector<HTMLButtonElement>('[role="menuitem"]');
  expect(cancel?.textContent).toBe("取消任务");
  expect(cancel?.className).toContain("text-danger-primary");
  expect(mocks.runNodeTaskAction).not.toHaveBeenCalled();
  await act(async () => cancel?.click());

  expect(container.querySelector("[data-reason-dialog]")?.textContent).toContain("取消原因");
  expect(peek?.querySelector('[role="menu"]')).toBeNull();
  await act(async () => button("确认提交").click());
  expect(mocks.runNodeTaskAction).not.toHaveBeenCalled();
  await setInput("[data-reason-dialog] textarea", "重复创建的任务");
  await act(async () => button("确认提交").click());
  expect(mocks.runNodeTaskAction).toHaveBeenCalledWith("lab", "chain-1", "node-1", "task-1", "cancel", {
    reason: "重复创建的任务",
  });
});

it("renders empty, forbidden, loading, refresh, and server rejection states", async () => {
  mocks.getNodeTasks.mockResolvedValueOnce([]);
  mocks.getAssignableUsers.mockResolvedValueOnce([]);
  await renderPanel();
  expect(container.textContent).toContain("当前节点还没有科研任务。");

  await act(async () => button("刷新").click());
  await act(async () => undefined);
  expect(mocks.getNodeTasks).toHaveBeenCalledTimes(2);

  mocks.getAssignableUsers.mockRejectedValueOnce({ error_code: "research_permission_denied" });
  await act(async () => button("刷新").click());
  await act(async () => undefined);
  expect(container.textContent).toContain("整理开题文献");
  expect(container.textContent).toContain("当前账号没有管理任务候选人的权限，任务仍为只读展示。");

  mocks.getAssignableUsers.mockResolvedValueOnce(candidates);
  await act(async () => button("刷新").click());
  await act(async () => undefined);
  mocks.createNodeTask.mockRejectedValueOnce({ error: "assignee is outside the assignable-user boundary." });
  await act(async () => button("+ 创建任务").click());
  await setInput('input:not([type="date"]):not([type="search"])', "越权任务");
  await act(async () => button("创建任务").click());
  expect(container.textContent).toContain("assignee is outside the assignable-user boundary.");
});

it("retains an invalid assignee name and explains how to restore membership", async () => {
  mocks.getNodeTasks.mockResolvedValue([task({ assignee_is_valid: false })]);
  mocks.getAssignableUsers.mockResolvedValue([]);
  await renderPanel();
  expect(container.textContent).toContain("李同学");
  await act(async () => button("整理开题文献").click());
  const peek = container.querySelector("aside");
  expect(peek?.textContent).toContain("李同学");
  expect(peek?.textContent).toContain("负责人已不具备有效课题成员资格，请补充成员或重新指派");
  expect(peek?.textContent).toContain("请先在课题成员中添加负责人");
  const select = peek?.querySelector('button[aria-label="责任人"]') as HTMLButtonElement;
  await act(async () => select.click());
  expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
  await clickOutsideMenu(peek.querySelector("h2") as Element);
  expect(container.querySelector('[role="listbox"]')).toBeNull();
  expect(mocks.updateNodeTask).not.toHaveBeenCalled();
});
