// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), patch: vi.fn() }));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@/hooks/store/use-research", () => ({ useResearch: () => ({ identity: { user: { is_main_pi: false } } }) }));
vi.mock("@/services/research/agent.service", () => ({
  ResearchAgentService: class {
    post = mocks.post;
    get = mocks.get;
    patch = mocks.patch;
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

const { FeedbackDialog } = await import("@/components/research/feedback/feedback-dialog");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

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

/** 打开反馈弹窗。 */
async function open() {
  await act(async () => root.render(<FeedbackDialog workspaceSlug="lab" />));
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="提交反馈或查看我的反馈"]')?.click()
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.get.mockResolvedValue({ data: { data: { results: [], count: 0 } } });
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

it("上游故障保留描述和三张截图，重试使用同一幂等键，成功才清空", async () => {
  mocks.post.mockRejectedValueOnce(new Error("AI4MS unavailable")).mockResolvedValueOnce({});
  await open();
  await describeFeedback("Upload fails on a weekly report");
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

it("普通用户查询本人记录，不显示管理入口且查看四状态与截图", async () => {
  mocks.get.mockResolvedValue({
    data: {
      data: {
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
            created_at: "2026-10-08T00:00:00Z",
            screenshots: [{ id: "shot-1" }],
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
      },
    },
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
  expect(container.textContent).toContain("Fixed");
  expect(container.querySelector('textarea[aria-label="处置说明"]')).toBeNull();
});
