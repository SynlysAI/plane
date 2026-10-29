// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import enTranslations from "../../../../packages/i18n/src/locales/en/common.json";
import zhTranslations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  todos: vi.fn(),
  locale: "zh-CN",
  copyTextToClipboard: vi.fn(),
  setToast: vi.fn(),
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const source = mocks.locale === "en" ? enTranslations : zhTranslations;
      const literal = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], source);
      const text = typeof literal === "string" ? literal : key;
      if (!values) return text;
      return Object.entries(values).reduce(
        (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
        text
      );
    },
    currentLocale: mocks.locale,
  }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@plane/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@plane/utils")>()),
  copyTextToClipboard: mocks.copyTextToClipboard,
}));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "SUCCESS", ERROR: "ERROR" },
  setToast: mocks.setToast,
}));
vi.mock("@/components/research/common/research-todo-urgency", () => ({ ResearchTodoUrgency: () => <span>逾期</span> }));
vi.mock("@/components/research/approvals/research-chain-stage-approval-queue", () => ({
  ResearchChainStageApprovalQueue: ({ activeId, onHandled }: { activeId: string; onHandled: (id: string) => void }) => (
    <aside data-testid="stage-approval-queue">
      <button type="button" onClick={() => onHandled(activeId)}>
        handle queue item
      </button>
    </aside>
  ),
}));
vi.mock("@/services/project-domains.service", () => ({
  ProjectDomainsService: class {
    todos = mocks.todos;
  },
  domainError: () => "请求失败",
}));
const { WorkspaceTodos } = await import("@/components/home/workspace-todos");
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const todo = (title = "采购", overrides: Record<string, unknown> = {}) => ({
  id: title,
  title,
  domain: "ADMINISTRATIVE",
  source: "WORK_ITEM",
  context: "项目",
  due_at: "2020-01-01",
  href: `/${title}`,
  requester: null,
  ...overrides,
});
const page = (items: Record<string, unknown>[], next: string | null = null) => ({
  results: items,
  next_cursor: next,
  total_count: items.length,
  degraded_sources: [],
});
/**
 * 按可访问名称查找按钮，避免同屏多个“复制”按钮误点。
 *
 * Args:
 *   label: 目标按钮的可访问名称。
 *
 * Returns:
 *   匹配的按钮元素。
 */
function buttonByName(label: string) {
  const target = container.querySelector(`button[aria-label="${label}"]`);
  expect(target).toBeInstanceOf(HTMLButtonElement);
  return target as HTMLButtonElement;
}
beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  mocks.todos.mockReset();
  mocks.copyTextToClipboard.mockReset();
  mocks.copyTextToClipboard.mockResolvedValue(undefined);
  mocks.setToast.mockReset();
});
afterEach(async () => {
  await act(async () => root.unmount());
});
it("shows both domains without filtering old unfinished tasks", async () => {
  mocks.todos.mockResolvedValue({
    ...page([todo(), todo("科研评审", { domain: "RESEARCH" })]),
    degraded_sources: ["RESEARCH:REPORT"],
  });
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  expect(container.querySelector('a[href="/采购"]')).not.toBeNull();
  expect(container.querySelector('a[href="/科研评审"]')).not.toBeNull();
  expect(container.textContent).toContain("部分来源暂时不可用");
});
it("paginates within one selected domain", async () => {
  mocks.todos.mockResolvedValueOnce(page([todo("first")], "next"));
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  mocks.todos.mockResolvedValueOnce(page([todo("second")]));
  await act(async () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "加载更多")?.click()
  );
  expect(mocks.todos).toHaveBeenLastCalledWith("lab", "all", "next");
  expect(container.querySelectorAll("li")).toHaveLength(2);
});
it("ignores a late response from the previous workspace", async () => {
  let resolve!: (value: unknown) => void;
  mocks.todos.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="first" />));
  mocks.todos.mockResolvedValueOnce(page([todo("current")]));
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="second" />));
  await act(async () => resolve(page("stale")));
  expect(container.textContent).toContain("current");
  expect(container.textContent).not.toContain("stale");
});

it("re-requests the server projection after a todo update event", async () => {
  mocks.todos.mockResolvedValueOnce(page([todo("重指派前")])).mockResolvedValueOnce(page([todo("重指派后")]));

  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  expect(container.textContent).toContain("重指派前");

  vi.useFakeTimers();
  await act(async () => {
    window.dispatchEvent(new CustomEvent("workspace-todos-updated"));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  vi.useRealTimers();

  expect(mocks.todos).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("重指派后");
  expect(container.textContent).not.toContain("重指派前");
});

it("opens chain-stage approvals in the continuous queue and hides handled items", async () => {
  mocks.todos.mockResolvedValue(
    page([
      todo("阶段一", {
        id: "research:CHAIN_STAGE_APPROVAL:stage-1",
        domain: "RESEARCH",
        source: "CHAIN_STAGE_APPROVAL",
        object_id: "stage-1",
        href: "/lab/research/chains/chain-1?stage=topic_evaluation&approval=1",
      }),
      todo("阶段二", {
        id: "research:CHAIN_STAGE_APPROVAL:stage-2",
        domain: "RESEARCH",
        source: "CHAIN_STAGE_APPROVAL",
        object_id: "stage-2",
        href: "/lab/research/chains/chain-1?stage=experiment&approval=1",
      }),
      todo("采购"),
    ])
  );
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));

  await act(async () => container.querySelector('a[href*="stage=topic_evaluation"]')?.click());

  expect(container.querySelector('[data-testid="stage-approval-queue"]')).not.toBeNull();
  expect(container.querySelectorAll("li")).toHaveLength(3);

  await act(async () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "handle queue item")?.click()
  );

  expect(container.textContent).not.toContain("阶段一");
  expect(container.textContent).toContain("阶段二");
  expect(container.querySelector('a[href="/采购"]')).not.toBeNull();
});

it("closes the queue after the last stage approval is handled", async () => {
  mocks.todos.mockResolvedValue(
    page([
      todo("最后阶段", {
        id: "research:CHAIN_STAGE_APPROVAL:stage-1",
        domain: "RESEARCH",
        source: "CHAIN_STAGE_APPROVAL",
        object_id: "stage-1",
        href: "/lab/research/chains/chain-1?stage=topic_evaluation&approval=1",
      }),
    ])
  );
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  await act(async () => container.querySelector('a[href*="stage=topic_evaluation"]')?.click());
  await act(async () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "handle queue item")?.click()
  );

  expect(container.querySelector('[data-testid="stage-approval-queue"]')).toBeNull();
  expect(container.textContent).toContain("阶段审批已全部处理。");
});

it("renders the completed queue hint in the English locale", async () => {
  mocks.locale = "en";
  mocks.todos.mockResolvedValue(
    page([
      todo("last stage", {
        id: "research:CHAIN_STAGE_APPROVAL:stage-1",
        domain: "RESEARCH",
        source: "CHAIN_STAGE_APPROVAL",
        object_id: "stage-1",
        href: "/lab/research/chains/chain-1?stage=topic_evaluation&approval=1",
      }),
    ])
  );
  try {
    await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
    await act(async () => container.querySelector('a[href*="stage=topic_evaluation"]')?.click());
    await act(async () =>
      [...container.querySelectorAll("button")].find((button) => button.textContent === "handle queue item")?.click()
    );

    expect(container.textContent).toContain("All stage approvals have been handled.");
  } finally {
    mocks.locale = "zh-CN";
  }
});

it("filters handled items from a late server response and coalesces refresh events", async () => {
  const latePage = page([
    todo("旧阶段", {
      id: "research:CHAIN_STAGE_APPROVAL:stage-1",
      domain: "RESEARCH",
      source: "CHAIN_STAGE_APPROVAL",
      object_id: "stage-1",
      href: "/lab/research/chains/chain-1?stage=topic_evaluation&approval=1",
    }),
    todo("采购"),
  ]);
  mocks.todos
    .mockResolvedValueOnce(latePage)
    .mockResolvedValueOnce(latePage)
    .mockResolvedValueOnce(page([todo("采购")]));
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  await act(async () => container.querySelector('a[href*="stage=topic_evaluation"]')?.click());
  await act(async () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "handle queue item")?.click()
  );

  vi.useFakeTimers();
  await act(async () => {
    window.dispatchEvent(new CustomEvent("workspace-todos-updated"));
    window.dispatchEvent(new CustomEvent("workspace-todos-updated"));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  vi.useRealTimers();

  expect(mocks.todos).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("旧阶段");
  expect(container.textContent).toContain("采购");
});

it("labels report submitters and other todo requesters", async () => {
  mocks.todos.mockResolvedValue(
    page([
      todo("2026-W39 周报", {
        domain: "RESEARCH",
        source: "REPORT",
        requester: { id: "student", display_name: "周报提交人" },
      }),
      todo("科研链任务", {
        domain: "RESEARCH",
        source: "CHAIN_TASK",
        requester: { id: "advisor", display_name: "科研负责人" },
      }),
      todo("行政任务", {
        requester: { id: "admin", display_name: "行政发起人" },
      }),
    ])
  );
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  expect(container.textContent).toContain("提交人：周报提交人");
  expect(container.textContent).toContain("发起人：科研负责人");
  expect(container.textContent).toContain("发起人：行政发起人");
});

it("copies research and administrative todo links with share context", async () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(window, "location");
  Object.defineProperty(window, "location", {
    value: { origin: "http://pilab.local" },
    configurable: true,
  });
  mocks.todos.mockResolvedValue(
    page([
      todo("科研采购审批", {
        domain: "RESEARCH",
        href: "/lab/research/chains/chain-1?node=node-1&task=task-1",
      }),
      todo("行政采购审批", { href: "/lab/projects/admin/task-1" }),
    ])
  );

  try {
    await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
    await act(async () => buttonByName("复制分享链接：科研采购审批").click());
    await act(async () => buttonByName("复制分享链接：行政采购审批").click());

    expect(mocks.copyTextToClipboard).toHaveBeenNthCalledWith(
      1,
      "OpenEVA 科研行动项: 科研采购审批 ( http://pilab.local/lab/research/chains/chain-1?node=node-1&task=task-1 )"
    );
    expect(mocks.copyTextToClipboard).toHaveBeenNthCalledWith(
      2,
      "OpenEVA 行政行动项: 行政采购审批 ( http://pilab.local/lab/projects/admin/task-1 )"
    );
    expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ type: "SUCCESS" }));
  } finally {
    if (locationDescriptor) Object.defineProperty(window, "location", locationDescriptor);
  }
});

it("shows a safe error toast when copying a todo link fails", async () => {
  mocks.todos.mockResolvedValue(page([todo("采购")]));
  mocks.copyTextToClipboard.mockRejectedValue(new Error("denied"));

  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  await act(async () => buttonByName("复制分享链接：采购").click());

  expect(mocks.setToast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "ERROR", title: "复制失败", message: "请稍后重试。" })
  );
});

it("omits requester metadata when the projection has no requester", async () => {
  mocks.todos.mockResolvedValue(page([todo()]));
  await act(async () => root.render(<WorkspaceTodos workspaceSlug="lab" />));
  expect(container.textContent).toContain("采购");
  expect(container.textContent).not.toContain("发起人：");
  expect(container.textContent).not.toContain("提交人：");
});
