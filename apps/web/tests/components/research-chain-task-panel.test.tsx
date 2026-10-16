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
}));

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
  },
}));

vi.mock("@/components/research/chains/research-task-comments", () => ({
  ResearchTaskComments: () => <section aria-label="评论">评论</section>,
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
    status: "SUBMITTED",
    assignee: "student-1",
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

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.getNodeTasks.mockResolvedValue([task()]);
  mocks.getAssignableUsers.mockResolvedValue(candidates);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderPanel() {
  const { ResearchChainTaskPanel } = await import("@/components/research/chains/research-chain-task-panel");
  await act(async () => {
    root.render(<ResearchChainTaskPanel workspaceSlug="lab" chainId="chain-1" nodeId="node-1" />);
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

async function setInput(selector: string, value: string) {
  const input = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

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
  expect(peek?.textContent).toContain("点击添加描述");
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
