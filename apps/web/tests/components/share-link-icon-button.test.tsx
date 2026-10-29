// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  copyTextToClipboard: vi.fn(),
  setToast: vi.fn(),
}));

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, string | number> = {}) =>
      ({
        "research.common.share_copied_title": "分享内容已复制",
        "research.common.share_copied_message": "标题和链接已复制到剪贴板。",
        "research.common.share_copy_failed_title": "复制失败",
        "research.common.share_copy_failed_message": "请稍后重试。",
      })[key]?.replaceAll("{title}", String(values.title ?? "")) ?? key,
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@plane/utils", () => ({ copyTextToClipboard: mocks.copyTextToClipboard }));
vi.mock("@plane/propel/toast", () => ({
  TOAST_TYPE: { SUCCESS: "SUCCESS", ERROR: "ERROR" },
  setToast: mocks.setToast,
}));
vi.mock("@makeplane/propel/components/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@plane/propel/icon-button", () => ({
  IconButton: ({
    icon: Icon,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: React.FC<{ className?: string }> }) => (
    <button type="button" {...props}>
      <Icon />
    </button>
  ),
}));

const { ShareLinkIconButton } = await import("@/components/common/share-link-icon-button");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.copyTextToClipboard.mockReset();
  mocks.copyTextToClipboard.mockResolvedValue(undefined);
  mocks.setToast.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("copies a typed share message with an absolute link", async () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(window, "location");
  Object.defineProperty(window, "location", { value: { origin: "http://pilab.local" }, configurable: true });

  try {
    await act(async () =>
      root.render(
        <ShareLinkIconButton
          typeLabel="行政工作项"
          title="采购审批"
          href="/lab/projects/admin/task-1"
          ariaLabel="复制分享链接：采购审批"
        />
      )
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="复制分享链接：采购审批"]')?.click()
    );

    expect(mocks.copyTextToClipboard).toHaveBeenCalledWith(
      "OpenEVA 行政工作项: 采购审批 ( http://pilab.local/lab/projects/admin/task-1 )"
    );
    expect(mocks.setToast).toHaveBeenCalledWith(expect.objectContaining({ type: "SUCCESS" }));
  } finally {
    if (locationDescriptor) Object.defineProperty(window, "location", locationDescriptor);
  }
});

it("shows a safe error toast when clipboard access fails", async () => {
  mocks.copyTextToClipboard.mockRejectedValue(new Error("denied"));

  await act(async () =>
    root.render(
      <ShareLinkIconButton
        typeLabel="科研工作项"
        title="论文写作"
        href="http://pilab.local/lab/research/chains/chain-1"
        ariaLabel="复制分享链接：论文写作"
      />
    )
  );
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="复制分享链接：论文写作"]')?.click()
  );

  expect(mocks.setToast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "ERROR", title: "复制失败", message: "请稍后重试。" })
  );
});
