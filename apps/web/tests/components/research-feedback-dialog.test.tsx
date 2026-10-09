// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), patch: vi.fn() }));
const researchState = {
  identity: null as { user: { is_main_pi: boolean; is_workspace_admin: boolean; is_system_admin: boolean } } | null,
  identityLoader: false,
};
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => researchState }));
vi.mock("@/services/research/feedback.service", () => ({
  ResearchFeedbackService: class {
    list = (workspaceSlug: string, params: Record<string, string>) =>
      mocks.get(`/api/research/workspaces/${workspaceSlug}/feedback/`, { params });
    create = (workspaceSlug: string, form: FormData) =>
      mocks.post(`/api/research/workspaces/${workspaceSlug}/feedback/`, form);
    updateStatus = (workspaceSlug: string, feedbackId: string, payload: unknown) =>
      mocks.patch(`/api/research/workspaces/${workspaceSlug}/feedback/${feedbackId}/status/`, payload);
    screenshotUrl = (workspaceSlug: string, feedbackId: string, screenshotId: string, manage = false) =>
      `/api/research/workspaces/${workspaceSlug}/feedback/${feedbackId}/screenshots/${screenshotId}/${
        manage ? "?scope=manage" : ""
      }`;
  },
}));
vi.mock("@plane/ui", () => ({
  ModalCore: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div role="dialog">{children}</div> : null,
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({ children, type, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type ?? "button"} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

const { FeedbackDialog, createIdempotencyKey } = await import("@/components/research/feedback/feedback-dialog");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

it("在不安全的 HTTP 来源没有 randomUUID 时仍生成幂等键", () => {
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
  expect(createIdempotencyKey()).toMatch(/^fallback-/);
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
});

/** 通过用户输入事件填写反馈，避免绕过表单状态。 */
async function describeFeedback(value: string) {
  const input = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="反馈描述"]');
  if (!input) throw new Error("反馈描述未显示");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** 为多图选择入口触发真实 change 事件。 */
async function pick(files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="反馈截图"]');
  if (!input) throw new Error("截图入口未显示");
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: files });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** Format a local date in the same shape as the feedback preset filter. */
function localDate(offsetDays: number) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(
    2,
    "0"
  )}`;
}

/** 打开反馈弹窗。 */
async function open() {
  await act(async () => root.render(<FeedbackDialog workspaceSlug="lab" />));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="提交反馈或查看我的反馈"]')?.click()
  );
}

/** 直接渲染反馈管理页形态。 */
async function renderManagementPage() {
  await act(async () => root.render(<FeedbackDialog workspaceSlug="lab" managementOnly />));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  researchState.identity = {
    user: { is_main_pi: false, is_workspace_admin: false, is_system_admin: false },
  };
  researchState.identityLoader = false;
  mocks.get.mockResolvedValue({ results: [], count: 0 });
  mocks.post.mockResolvedValue({});
  let preview = 0;
  URL.createObjectURL = vi.fn(() => `blob:feedback-${++preview}`);
  URL.revokeObjectURL = vi.fn();
  window.history.replaceState({}, "", "/lab/research?access_token=secret#private");
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it("Plane API 故障保留描述和三张截图，重试使用同一幂等键，成功才清空", async () => {
  mocks.post.mockRejectedValueOnce(new Error("Plane feedback storage unavailable")).mockResolvedValueOnce({});
  await open();
  await describeFeedback("Upload fails on a weekly report");
  expect(
    Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("添加截图"))
      ?.textContent
  ).toContain("0/3");
  await pick([
    new File(["PNG"], "one.png", { type: "image/png" }),
    new File(["JPEG"], "two.jpg", { type: "image/jpeg" }),
    new File(["WEBP"], "three.webp", { type: "image/webp" }),
  ]);
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(3);
  await act(async () =>
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("表单和截图已保留");
  expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="反馈描述"]')?.value).toBe(
    "Upload fails on a weekly report"
  );
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(3);
  const first = mocks.post.mock.calls[0][1] as FormData;
  expect(first.get("path")).toBe("/lab/research");
  expect(first.getAll("screenshots")).toHaveLength(3);
  expect(first.has("page_body")).toBe(false);

  await act(async () =>
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );

  const second = mocks.post.mock.calls[1][1] as FormData;
  expect(second.get("idempotency_key")).toBe(first.get("idempotency_key"));
  expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="反馈描述"]')?.value).toBe("");
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(0);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("反馈已提交");
});

it("移除截图释放预览，第四张与错误类型不会进入提交清单", async () => {
  await open();
  await pick(Array.from({ length: 3 }, (_, index) => new File(["PNG"], `${index}.png`, { type: "image/png" })));
  await pick([new File(["PNG"], "fourth.png", { type: "image/png" })]);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("最多 3 张");
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(3);
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "移除截图 2")
      ?.click()
  );
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(2);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:feedback-2");
  await pick([new File(["GIF"], "not-allowed.gif", { type: "image/gif" })]);
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(2);
});

it("列表读取时显示加载态，不误报空结果", async () => {
  mocks.get.mockReturnValue(new Promise(() => undefined));
  await open();
  await act(async () => container.querySelector<HTMLButtonElement>('button[role="tab"]:nth-child(2)')?.click());

  expect(container.querySelector('[role="status"]')?.textContent).toContain("反馈读取中");
  expect(container.textContent).not.toContain("当前范围内没有反馈记录");
});

it("列表失败提供重试，重试成功后展示结果", async () => {
  mocks.get.mockRejectedValueOnce(new Error("feedback list unavailable")).mockResolvedValue({ results: [], count: 0 });
  await open();
  await act(async () => container.querySelector<HTMLButtonElement>('button[role="tab"]:nth-child(2)')?.click());
  await act(async () => undefined);

  expect(container.querySelector('[role="alert"]')?.textContent).toContain("反馈读取失败");
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "重试")
      ?.click()
  );
  await act(async () => undefined);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("当前范围内没有反馈记录");
});

it("关键词与模块筛选延迟 300 毫秒后请求", async () => {
  await open();
  await act(async () => container.querySelector<HTMLButtonElement>('button[role="tab"]:nth-child(2)')?.click());
  const callsBefore = mocks.get.mock.calls.length;
  const keyword = container.querySelector<HTMLInputElement>('input[aria-label="反馈关键词"]');
  if (!keyword) throw new Error("反馈关键词未显示");

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(keyword, "upload");
    keyword.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(mocks.get.mock.calls.length).toBe(callsBefore);

  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  expect(mocks.get.mock.calls.length).toBe(callsBefore + 1);
  expect(mocks.get).toHaveBeenLastCalledWith(
    "/api/research/workspaces/lab/feedback/",
    expect.objectContaining({ params: expect.objectContaining({ q: "upload" }) })
  );
});

it("我的反馈日期筛选支持任意、预设与自定义区间", async () => {
  await open();
  await act(async () => container.querySelector<HTMLButtonElement>('button[role="tab"]:nth-child(2)')?.click());
  const preset = container.querySelector<HTMLSelectElement>('select[aria-label="反馈日期范围"]');
  if (!preset) throw new Error("反馈日期范围未显示");
  expect(container.querySelector('input[aria-label="反馈开始日期"]')).toBeNull();

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(preset, "7");
    preset.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(mocks.get).toHaveBeenLastCalledWith(
    "/api/research/workspaces/lab/feedback/",
    expect.objectContaining({
      params: expect.objectContaining({ date_from: localDate(-6), date_to: localDate(0), page: "1" }),
    })
  );

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(preset, "custom");
    preset.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const start = container.querySelector<HTMLInputElement>('input[aria-label="反馈开始日期"]');
  const end = container.querySelector<HTMLInputElement>('input[aria-label="反馈结束日期"]');
  if (!start || !end) throw new Error("自定义日期区间未显示");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(start, "2026-10-01");
    start.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(end, "2026-10-08");
    end.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(mocks.get).toHaveBeenLastCalledWith(
    "/api/research/workspaces/lab/feedback/",
    expect.objectContaining({
      params: expect.objectContaining({ date_from: "2026-10-01", date_to: "2026-10-08" }),
    })
  );
});

it("普通用户查询本人记录，不显示管理入口且查看四状态与截图", async () => {
  mocks.get.mockResolvedValue({
    count: 1,
    results: [
      {
        feedback_id: "feedback-1",
        content: "Resolved feedback",
        feedback_type: "bug",
        status: "done",
        username: "Student",
        path: "/lab/research",
        browser: "Browser",
        module: "research",
        created_at: "2026-10-08T00:00:00Z",
        screenshots: [{ id: "shot-1", content_type: "image/png", size: 32 }],
        history: [
          {
            actor_name: "PI",
            from_status: "open",
            to_status: "done",
            comment: "Fixed",
            created_at: "2026-10-08T01:00:00Z",
          },
        ],
      },
    ],
  });
  await open();
  await act(async () => container.querySelector<HTMLButtonElement>('button[role="tab"]:nth-child(2)')?.click());
  expect(mocks.get).toHaveBeenCalledWith(
    "/api/research/workspaces/lab/feedback/",
    expect.objectContaining({ params: expect.not.objectContaining({ scope: "manage" }) })
  );
  expect(container.textContent).not.toContain("反馈管理");
  expect(container.textContent).toContain("已解决");
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Resolved feedback")
      ?.click()
  );
  expect(container.querySelector('img[alt="反馈截图 1"]')?.getAttribute("src")).toContain(
    "feedback-1/screenshots/shot-1/"
  );
  expect(container.querySelector('[role="tabpanel"]')).not.toBeNull();
  expect(container.textContent).toContain("缺陷 · research");
  expect(container.textContent).toContain("浏览器");
  expect(container.textContent).toContain("Browser");
  expect(container.textContent).toContain("Fixed");
  await act(async () => {
    container.querySelector('img[alt="反馈截图 1"]')?.dispatchEvent(new Event("error", { bubbles: true }));
  });
  expect(container.textContent).toContain("截图暂不可用");
  expect(container.querySelector('textarea[aria-label="处置说明"]')).toBeNull();
});

it("普通成员直达管理页显示权限态，不发起管理请求", async () => {
  await renderManagementPage();
  await act(async () => undefined);

  expect(mocks.get).not.toHaveBeenCalled();
  expect(container.textContent).toContain("无权限访问反馈管理");
  expect(container.querySelector('[role="tabpanel"]')).toBeNull();
});

it("管理页等待身份加载，身份确认有权限后自动发起管理请求", async () => {
  researchState.identity = null;
  researchState.identityLoader = true;
  await renderManagementPage();
  await act(async () => undefined);
  expect(mocks.get).not.toHaveBeenCalled();
  expect(container.textContent).toContain("反馈权限读取中");

  researchState.identity = {
    user: { is_main_pi: true, is_workspace_admin: false, is_system_admin: false },
  };
  researchState.identityLoader = false;
  await renderManagementPage();
  await act(async () => undefined);

  expect(mocks.get).toHaveBeenCalledWith(
    "/api/research/workspaces/lab/feedback/",
    expect.objectContaining({ params: expect.objectContaining({ scope: "manage" }) })
  );
});

it("列表刷新后清除不在当前结果中的陈旧选中记录", async () => {
  mocks.get.mockResolvedValueOnce({
    count: 1,
    results: [
      {
        feedback_id: "feedback-old",
        content: "Selected feedback",
        feedback_type: "bug",
        status: "open",
        username: "Student",
        path: "/lab/research",
        browser: "Browser",
        module: "research",
        created_at: "2026-10-08T00:00:00Z",
        screenshots: [],
        history: [],
      },
    ],
  });
  await open();
  await act(async () => container.querySelector<HTMLButtonElement>('button[role="tab"]:nth-child(2)')?.click());
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Selected feedback")
      ?.click()
  );
  expect(container.textContent).toContain("Selected feedback");

  mocks.get.mockResolvedValueOnce({ count: 0, results: [] });
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "刷新")
      ?.click()
  );
  await act(async () => undefined);

  expect(container.textContent).not.toContain("Selected feedback");
  expect(container.textContent).toContain("当前范围内没有反馈记录");
});

it("主 PI 进入管理视图，使用管理范围读取并更新状态", async () => {
  researchState.identity = {
    user: { is_main_pi: true, is_workspace_admin: false, is_system_admin: false },
  };
  mocks.get.mockResolvedValue({
    count: 1,
    results: [
      {
        feedback_id: "feedback-manage",
        content: "Manage this feedback",
        feedback_type: "ux",
        status: "open",
        username: "Student",
        path: "/lab/research",
        browser: "Browser",
        created_at: "2026-10-08T00:00:00Z",
        screenshots: [{ id: "shot-manage", content_type: "image/png", size: 32 }],
        history: [],
      },
    ],
  });
  mocks.patch.mockResolvedValue({
    feedback_id: "feedback-manage",
    content: "Manage this feedback",
    feedback_type: "ux",
    status: "in_progress",
    username: "Student",
    path: "/lab/research",
    browser: "Browser",
    created_at: "2026-10-08T00:00:00Z",
    screenshots: [],
    history: [],
    updated_at: "2026-10-08T02:00:00Z",
  });
  await renderManagementPage();
  expect(container.querySelector("h1")?.textContent).toBe("反馈管理");
  expect(container.querySelector('[role="tablist"]')).toBeNull();
  expect(container.textContent).toContain("选择左侧任意反馈后");
  expect(mocks.get).toHaveBeenCalledWith(
    "/api/research/workspaces/lab/feedback/",
    expect.objectContaining({ params: expect.objectContaining({ scope: "manage" }) })
  );
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Manage this feedback")
      ?.click()
  );
  expect(container.querySelector('img[alt="反馈截图 1"]')?.getAttribute("src")).toContain("?scope=manage");
  const commentBox = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="处置说明"]');
  await act(async () => {
    if (!commentBox) throw new Error("处置说明未显示");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(commentBox, "Assigned");
    commentBox.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(mocks.patch).toHaveBeenCalledWith("/api/research/workspaces/lab/feedback/feedback-manage/status/", {
    status: "in_progress",
    comment: "Assigned",
  });
  expect(container.textContent).toContain("处理中");
});
