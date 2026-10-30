// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), patch: vi.fn() }));
const researchState = {
  identity: null as {
    user: {
      is_main_pi: boolean;
      is_research_admin?: boolean;
      is_workspace_admin: boolean;
      is_system_admin: boolean;
      is_feedback_operator?: boolean;
    };
  } | null,
  identityLoader: false,
};
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => researchState }));
vi.mock("@/services/research/feedback.service", () => ({
  ResearchFeedbackService: class {
    list = (workspaceSlug: string, params: Record<string, string>) =>
      mocks.get(`/api/research/workspaces/${workspaceSlug}/feedback/`, { params });
    getFeedback = (workspaceSlug: string, feedbackId: string, params: Record<string, string>) =>
      mocks.get(`/api/research/workspaces/${workspaceSlug}/feedback/${feedbackId}/`, { params });
    create = (workspaceSlug: string, form: FormData) =>
      mocks.post(`/api/research/workspaces/${workspaceSlug}/feedback/`, form);
    updateStatus = (workspaceSlug: string, feedbackId: string, payload: unknown) =>
      mocks.patch(`/api/research/workspaces/${workspaceSlug}/feedback/${feedbackId}/status/`, payload);
    createReply = (workspaceSlug: string, feedbackId: string, payload: unknown) =>
      mocks.post(`/api/research/workspaces/${workspaceSlug}/feedback/${feedbackId}/replies/`, payload);
    screenshotUrl = (
      workspaceSlug: string,
      feedbackId: string,
      screenshotId: string,
      scope: "own" | "workspace" | "manage" = "own"
    ) =>
      `/api/research/workspaces/${workspaceSlug}/feedback/${feedbackId}/screenshots/${screenshotId}/${
        scope === "own" ? "" : `?scope=${scope}`
      }`;
  },
}));
vi.mock("@plane/ui", async () => ({
  ...(await vi.importActual("@plane/ui")),
  ModalCore: ({
    isOpen,
    children,
    width,
    className,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    width?: string;
    className?: string;
  }) =>
    isOpen ? (
      <div role="dialog" data-width={width} data-class-name={className}>
        {children}
      </div>
    ) : null,
}));
vi.mock("@plane/propel/button", () => ({
  Button: ({
    children,
    type,
    onClick,
    disabled,
    "aria-label": ariaLabel,
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type ?? "button"} onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}));
vi.mock("@plane/propel/calendar", () => ({
  Calendar: ({ onSelect, disabled }: { onSelect: (date: Date | undefined) => void; disabled?: { after?: Date } }) => (
    <div data-testid="period-calendar">
      <button type="button" onClick={() => onSelect(new Date(2026, 8, 15))}>
        选择 2026-09-15
      </button>
      <button type="button" onClick={() => onSelect(new Date(2027, 0, 1))}>
        选择未来日期
      </button>
      <span data-testid="disabled-after">{disabled?.after?.toISOString()}</span>
    </div>
  ),
}));

vi.mock("@plane/propel/popover", () => {
  return {
    Popover: Object.assign(({ children }: { children: React.ReactNode }) => <>{children}</>, {
      Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    }),
  };
});

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

/** 在指定元素触发带文件的原生粘贴事件，模拟用户粘贴截图。 */
async function paste(files: File[], target?: Element) {
  return pasteFromClipboardSources(files, files, target);
}

/** 分别构造 files 与 items 暴露的文件，模拟浏览器返回不同 File 对象的情况。 */
async function pasteFromClipboardSources(files: File[], itemFiles: File[], target?: Element) {
  const pasteTarget = target ?? container.querySelector<HTMLTextAreaElement>('textarea[aria-label="反馈描述"]');
  if (!pasteTarget) throw new Error("粘贴目标未显示");

  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files,
      items: itemFiles.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file })),
    },
  });
  await act(async () => pasteTarget.dispatchEvent(event));
  return event;
}

/** 打开反馈弹窗。 */
async function open() {
  await act(async () => root.render(<FeedbackDialog workspaceSlug="lab" />));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="提交反馈或查看反馈统计"]')?.click()
  );
}

/** 直接渲染反馈管理页形态。 */
async function renderManagementPage() {
  await act(async () => root.render(<FeedbackDialog workspaceSlug="lab" managementOnly />));
}

/** 渲染通知深链使用的反馈中心页面形态。 */
async function renderFeedbackCenter(feedbackId?: string) {
  await act(async () => root.render(<FeedbackDialog workspaceSlug="lab" standalone initialFeedbackId={feedbackId} />));
  await act(async () => undefined);
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  researchState.identity = {
    user: { is_main_pi: false, is_research_admin: false, is_workspace_admin: false, is_system_admin: false },
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
  expect(container.textContent).toContain("添加截图（0/3）");
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

it("粘贴截图进入预览并随反馈一起提交，纯文本粘贴不被拦截", async () => {
  await open();
  await describeFeedback("Pasted screenshot cannot be previewed");
  const pasted = new File(["PASTED"], "pasted.png", { type: "image/png" });

  const imageEvent = await paste([pasted]);
  expect(imageEvent.defaultPrevented).toBe(true);
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(1);

  await act(async () =>
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  const form = mocks.post.mock.calls[0][1] as FormData;
  expect(form.getAll("screenshots")).toEqual([pasted]);

  const textEvent = await paste([]);
  expect(textEvent.defaultPrevented).toBe(false);
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(0);
});

it("粘贴截图复用数量、类型与大小限制", async () => {
  await open();
  const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" });
  await paste([oversized]);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("最多 3 张");
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(0);

  await paste([new File(["GIF"], "not-allowed.gif", { type: "image/gif" })]);
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(0);

  await paste(Array.from({ length: 3 }, (_, index) => new File(["PNG"], `${index}.png`, { type: "image/png" })));
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(3);

  await paste([new File(["PNG"], "fourth.png", { type: "image/png" })]);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("最多 3 张");
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(3);
});

it("同一粘贴图片在 files 与 items 中对象不同，仍只添加并提交一次", async () => {
  await open();
  await describeFeedback("Clipboard image is duplicated");
  const directFile = new File(["PASTED"], "pasted.png", { type: "image/png", lastModified: 123456 });
  const itemFile = new File(["PASTED"], "pasted.png", { type: "image/png", lastModified: 123456 });

  const event = await pasteFromClipboardSources([directFile], [itemFile]);
  expect(event.defaultPrevented).toBe(true);
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(1);

  await act(async () =>
    container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  const form = mocks.post.mock.calls[0][1] as FormData;
  expect(form.getAll("screenshots")).toEqual([directFile]);
});

it("files 为空时仍可从 items 粘贴截图", async () => {
  await open();
  const itemFile = new File(["ITEM"], "item.png", { type: "image/png" });

  const event = await pasteFromClipboardSources([], [itemFile]);
  expect(event.defaultPrevented).toBe(true);
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(1);
});

it("一次粘贴多张不同图片不会被误合并", async () => {
  await open();
  const directFiles = [0, 1].map(
    (index) => new File([`PNG-${index}`], `${index}.png`, { type: "image/png", lastModified: 123456 })
  );
  const itemFiles = [0, 1].map(
    (index) => new File([`PNG-${index}`], `${index}.png`, { type: "image/png", lastModified: 123456 })
  );

  await pasteFromClipboardSources(directFiles, itemFiles);
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(2);
});

it("切换到我的反馈后，粘贴图片不会进入提交清单", async () => {
  await open();
  await act(async () => container.querySelector<HTMLButtonElement>('button[role="tab"]:nth-child(2)')?.click());
  const panel = container.querySelector('[role="tabpanel"]');
  if (!panel) throw new Error("反馈面板未显示");

  const event = await paste([new File(["PNG"], "pasted.png", { type: "image/png" })], panel);
  expect(event.defaultPrevented).toBe(false);
  expect(container.querySelectorAll('img[alt$="预览"]')).toHaveLength(0);
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

it("关键词输入不请求，Enter 或搜索按钮确认后才请求", async () => {
  await open();
  await act(async () => container.querySelector<HTMLButtonElement>('button[role="tab"]:nth-child(2)')?.click());
  await act(async () => undefined);
  const callsBefore = mocks.get.mock.calls.length;
  const keyword = container.querySelector<HTMLInputElement>('input[aria-label="反馈关键词"]');
  if (!keyword) throw new Error("反馈关键词未显示");
  expect(container.querySelector('input[aria-label="反馈模块"]')).toBeNull();

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(keyword, "upload");
    keyword.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  expect(mocks.get.mock.calls.length).toBe(callsBefore);

  await act(async () =>
    container
      .querySelector('form[data-keyword-filter="true"]')
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(mocks.get.mock.calls.length).toBe(callsBefore + 1);
  expect(mocks.get).toHaveBeenLastCalledWith(
    "/api/research/workspaces/lab/feedback/",
    expect.objectContaining({ params: expect.objectContaining({ q: "upload", page: "1" }) })
  );

  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(keyword, "weekly");
    keyword.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent === "搜索")
      ?.click()
  );
  expect(mocks.get.mock.calls.length).toBe(callsBefore + 2);
  expect(mocks.get).toHaveBeenLastCalledWith(
    "/api/research/workspaces/lab/feedback/",
    expect.objectContaining({ params: expect.objectContaining({ q: "weekly", page: "1" }) })
  );
});

it("我的反馈日期筛选复用周报周/月日历并支持清除", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 27, 15, 0, 0));
  try {
    await open();
    await act(async () => container.querySelector<HTMLButtonElement>('button[role="tab"]:nth-child(2)')?.click());
    await act(async () => undefined);
    expect(container.textContent).toContain("任意时间");
    expect(container.querySelector('select[aria-label="反馈日期范围"]')).toBeNull();

    await act(async () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.getAttribute("aria-label") === "反馈日期周期")
        ?.click()
    );
    await act(async () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent === "选择 2026-09-15")
        ?.click()
    );

    expect(container.textContent).toContain("2026-W38");
    expect(mocks.get).toHaveBeenLastCalledWith(
      "/api/research/workspaces/lab/feedback/",
      expect.objectContaining({
        params: expect.objectContaining({ date_from: "2026-09-14", date_to: "2026-09-20", page: "1" }),
      })
    );

    await act(async () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
        .find((button) => button.textContent === "清除日期")
        ?.click()
    );
    expect(container.textContent).toContain("任意时间");
    expect(mocks.get).toHaveBeenLastCalledWith(
      "/api/research/workspaces/lab/feedback/",
      expect.objectContaining({ params: expect.objectContaining({ date_from: "", date_to: "", page: "1" }) })
    );
  } finally {
    vi.useRealTimers();
  }
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

it("普通提交者可在我的反馈中持续回复，并按时间混合查看动态", async () => {
  const feedback = {
    feedback_id: "feedback-own-reply",
    content: "Own feedback needs more discussion",
    feedback_type: "ux",
    status: "in_progress",
    username: "Student",
    path: "/lab/research",
    browser: "Browser",
    module: "research",
    created_at: "2026-10-08T00:00:00Z",
    screenshots: [],
    history: [
      {
        actor_name: "PI",
        from_status: "open",
        to_status: "in_progress",
        comment: "Status changed later",
        created_at: "2026-10-08T02:00:00Z",
      },
    ],
    replies: [
      {
        id: "reply-old",
        content: "Earlier reply",
        author_name: "PI",
        created_at: "2026-10-08T01:00:00Z",
      },
    ],
  };
  const updated = {
    ...feedback,
    replies: [
      ...feedback.replies,
      {
        id: "reply-new",
        content: "Still reproduces after the patch",
        author_name: "Student",
        created_at: "2026-10-08T03:00:00Z",
      },
    ],
  };
  mocks.get.mockResolvedValue({ count: 1, results: [feedback] });
  mocks.post.mockResolvedValue(updated);

  await open();
  await act(async () => container.querySelector<HTMLButtonElement>('button[role="tab"]:nth-child(2)')?.click());
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Own feedback needs more discussion"))
      ?.click()
  );

  const timeline = container.querySelector('section[aria-label="反馈讨论与处理动态"]');
  expect(timeline?.textContent?.indexOf("Earlier reply")).toBeLessThan(
    timeline?.textContent?.indexOf("Status changed later") ?? -1
  );
  const replyBox = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="反馈回复"]');
  if (!replyBox) throw new Error("提交者回复输入未显示");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      replyBox,
      "Still reproduces after the patch"
    );
    replyBox.dispatchEvent(new Event("input", { bubbles: true }));
  });
  mocks.get.mockResolvedValue({ count: 1, results: [updated] });
  await act(async () =>
    container
      .querySelector('form[data-reply-form="true"]')
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  expect(mocks.post).toHaveBeenCalledWith("/api/research/workspaces/lab/feedback/feedback-own-reply/replies/", {
    content: "Still reproduces after the patch",
  });
  expect(container.textContent).toContain("Still reproduces after the patch");
});

it("反馈中心深链先读取详情并保留选中记录", async () => {
  const detail = {
    feedback_id: "feedback-deep-link",
    content: "Deep linked feedback",
    feedback_type: "bug",
    status: "open",
    username: "Student",
    path: "/lab/research",
    browser: "Browser",
    module: "research",
    created_at: "2026-10-08T00:00:00Z",
    screenshots: [],
    history: [],
    replies: [],
  };
  mocks.get.mockImplementation(async (url: string) =>
    url.endsWith("/feedback/") ? { count: 0, results: [] } : { ...detail }
  );

  await renderFeedbackCenter("feedback-deep-link");

  expect(mocks.get).toHaveBeenCalledWith("/api/research/workspaces/lab/feedback/feedback-deep-link/", {
    params: { scope: "own" },
  });
  expect(container.textContent).toContain("Deep linked feedback");
  expect(container.querySelector('[data-testid="feedback-management-split"]')).not.toBeNull();
});

it("普通成员查看工作空间反馈统计，只读且可读取他人截图与历史", async () => {
  mocks.get.mockResolvedValue({
    count: 1,
    results: [
      {
        feedback_id: "feedback-workspace",
        content: "Workspace feedback from another member",
        feedback_type: "idea",
        status: "in_progress",
        username: "Colleague",
        path: "/lab/projects",
        browser: "Workspace browser",
        module: "projects",
        created_at: "2026-10-08T00:00:00Z",
        screenshots: [{ id: "shot-workspace", content_type: "image/png", size: 32 }],
        history: [
          {
            actor_name: "PI",
            from_status: "open",
            to_status: "in_progress",
            comment: "Assigned to platform team",
            created_at: "2026-10-08T01:00:00Z",
          },
        ],
      },
    ],
  });
  await open();
  await act(async () =>
    Array.from(container.querySelectorAll('button[role="tab"]'))
      .find((button) => button.textContent === "反馈统计")
      ?.click()
  );

  expect(mocks.get).toHaveBeenCalledWith(
    "/api/research/workspaces/lab/feedback/",
    expect.objectContaining({ params: expect.objectContaining({ scope: "workspace" }) })
  );
  expect(container.querySelector('[data-testid="feedback-management-split"]')).not.toBeNull();
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Workspace feedback from another member"))
      ?.click()
  );
  expect(container.textContent).toContain("Colleague");
  expect(container.textContent).toContain("/lab/projects");
  expect(container.textContent).toContain("Workspace browser");
  expect(container.textContent).toContain("Assigned to platform team");
  expect(container.querySelector('img[alt="反馈截图 1"]')?.getAttribute("src")).toContain("?scope=workspace");
  expect(container.querySelector('textarea[aria-label="处置说明"]')).toBeNull();
  expect(container.querySelector('textarea[aria-label="反馈回复"]')).toBeNull();
  expect(mocks.patch).not.toHaveBeenCalled();
});

it("运维账号可在反馈统计详情回复，但不能处置状态", async () => {
  researchState.identity = {
    user: {
      is_main_pi: false,
      is_research_admin: false,
      is_workspace_admin: false,
      is_system_admin: false,
      is_feedback_operator: true,
    },
  };
  const feedback = {
    feedback_id: "feedback-operator",
    content: "Operator feedback",
    feedback_type: "bug",
    status: "open",
    username: "Student",
    path: "/lab/research",
    browser: "Browser",
    module: "research",
    created_at: "2026-10-08T00:00:00Z",
    screenshots: [],
    history: [],
    replies: [
      {
        id: "reply-1",
        content: "Existing reply",
        author_name: "Operations",
        created_at: "2026-10-08T01:00:00Z",
      },
    ],
  };
  const updatedFeedback = {
    ...feedback,
    replies: [
      ...feedback.replies,
      {
        id: "reply-2",
        content: "We are checking the deployment.",
        author_name: "Operations",
        created_at: "2026-10-08T02:00:00Z",
      },
    ],
  };
  mocks.get.mockResolvedValue({ count: 1, results: [feedback] });
  let resolveReply: (value: unknown) => void;
  mocks.post.mockImplementation(() => new Promise((resolve) => (resolveReply = resolve)));

  await open();
  await act(async () => container.querySelector<HTMLButtonElement>('button[role="tab"]:nth-child(3)')?.click());
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Operator feedback"))
      ?.click()
  );

  expect(container.textContent).toContain("Existing reply");
  expect(container.querySelector('textarea[aria-label="处置说明"]')).toBeNull();
  const replyBox = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="反馈回复"]');
  if (!replyBox) throw new Error("反馈回复输入未显示");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      replyBox,
      "We are checking the deployment."
    );
    replyBox.dispatchEvent(new Event("input", { bubbles: true }));
  });
  mocks.get.mockResolvedValue({ count: 1, results: [updatedFeedback] });
  await act(async () =>
    container
      .querySelector('form[data-reply-form="true"]')
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  const sendReplyButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent === "回复中"
  );
  expect(sendReplyButton?.disabled).toBe(true);
  await act(async () => {
    resolveReply(updatedFeedback);
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

  expect(mocks.post).toHaveBeenCalledWith("/api/research/workspaces/lab/feedback/feedback-operator/replies/", {
    content: "We are checking the deployment.",
  });
  expect(container.textContent).toContain("We are checking the deployment.");
  expect(mocks.patch).not.toHaveBeenCalled();
});

it("管理员在反馈统计页签继续提供状态处置并使用工作空间截图范围", async () => {
  researchState.identity = {
    user: { is_main_pi: true, is_research_admin: false, is_workspace_admin: false, is_system_admin: false },
  };
  mocks.get.mockResolvedValue({
    count: 1,
    results: [
      {
        feedback_id: "feedback-dialog-manage",
        content: "Manage from dialog",
        feedback_type: "ux",
        status: "open",
        username: "Student",
        path: "/lab/research",
        browser: "Browser",
        module: "research",
        created_at: "2026-10-08T00:00:00Z",
        screenshots: [{ id: "shot-dialog", content_type: "image/png", size: 32 }],
        history: [],
      },
    ],
  });
  mocks.patch.mockResolvedValue({
    feedback_id: "feedback-dialog-manage",
    content: "Manage from dialog",
    feedback_type: "ux",
    status: "in_progress",
    username: "Student",
    path: "/lab/research",
    browser: "Browser",
    module: "research",
    created_at: "2026-10-08T00:00:00Z",
    screenshots: [],
    history: [],
  });

  await open();
  await act(async () => container.querySelector<HTMLButtonElement>('button[role="tab"]:nth-child(3)')?.click());
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Manage from dialog"))
      ?.click()
  );

  const split = container.querySelector('[data-testid="feedback-management-split"]');
  expect(split?.className).toContain("md:grid-cols-");
  expect(container.querySelector('[role="dialog"]')?.getAttribute("data-width")).toContain("max-w-6xl");
  expect(container.querySelector('[role="dialog"]')?.getAttribute("data-class-name")).toContain("overflow-hidden");
  expect(container.querySelector('section[aria-label="反馈清单"]')).not.toBeNull();
  expect(container.querySelector('section[aria-label="反馈详情"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="feedback-list-scroll"]')?.className).toContain("overflow-y-auto");
  expect(container.querySelector('[data-testid="feedback-detail-scroll"]')?.className).toContain("overflow-y-auto");
  expect(container.querySelector('img[alt="反馈截图 1"]')?.getAttribute("src")).toContain("?scope=workspace");
  expect(container.querySelector('textarea[aria-label="处置说明"]')).not.toBeNull();
  const commentBox = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="处置说明"]');
  if (!commentBox) throw new Error("处置说明未显示");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(commentBox, "Assigned");
    commentBox.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    container
      .querySelector('form[data-status-form="true"]')
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(mocks.patch).toHaveBeenCalledWith("/api/research/workspaces/lab/feedback/feedback-dialog-manage/status/", {
    status: "in_progress",
    comment: "Assigned",
  });
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
      .find((button) => button.getAttribute("aria-label") === "刷新")
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
  // 页面标题由 ResearchPageShell 统一渲染，管理视图内部不再重复标题与视图页签。
  expect(container.querySelector("h1")).toBeNull();
  expect(container.querySelector('[role="tablist"]')).toBeNull();
  expect(container.textContent).toContain("选择左侧任意反馈后");
  const split = container.querySelector('[data-testid="feedback-management-split"]');
  const listPane = container.querySelector('section[aria-label="反馈清单"]');
  const detailPane = container.querySelector('section[aria-label="反馈详情"]');
  expect(split?.className).toContain("md:grid-cols-");
  expect(listPane?.compareDocumentPosition(detailPane as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(container.querySelector('[data-testid="feedback-list-scroll"]')?.className).toContain("overflow-y-auto");
  expect(container.querySelector('[data-testid="feedback-detail-scroll"]')?.className).toContain("overflow-y-auto");
  expect(mocks.get).toHaveBeenCalledWith(
    "/api/research/workspaces/lab/feedback/",
    expect.objectContaining({ params: expect.objectContaining({ scope: "manage" }) })
  );
  await act(async () =>
    Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Manage this feedback"))
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
    container
      .querySelector('form[data-status-form="true"]')
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  );
  expect(mocks.patch).toHaveBeenCalledWith("/api/research/workspaces/lab/feedback/feedback-manage/status/", {
    status: "in_progress",
    comment: "Assigned",
  });
  expect(container.textContent).toContain("处理中");
});
