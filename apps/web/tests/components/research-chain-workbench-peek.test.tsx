// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { ResearchChainWorkbenchPeek } = await import("@/components/research/chains/research-chain-workbench-peek");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let outsideTarget: HTMLButtonElement;

/** 渲染带独立交互边界的科研工作台 Peek。 */
async function renderPeek(onClose: () => void) {
  await act(async () =>
    root.render(
      <ResearchChainWorkbenchPeek title="课题任务" onClose={onClose}>
        {createPortal(
          <div data-prevent-outside-click="true">
            <button type="button">下一页</button>
          </div>,
          document.body
        )}
      </ResearchChainWorkbenchPeek>
    )
  );
}

/** 触发浏览器外点检测使用的 mousedown 事件。 */
function mousedown(target: Element) {
  act(() => {
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  outsideTarget = document.createElement("button");
  outsideTarget.type = "button";
  outsideTarget.textContent = "普通外部区域";
  document.body.append(outsideTarget);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  outsideTarget.remove();
  vi.clearAllMocks();
});

it("does not close when clicking a child marked as an independent interaction boundary", async () => {
  const onClose = vi.fn();
  await renderPeek(onClose);
  const nextPage = [...document.querySelectorAll("button")].find((button) => button.textContent === "下一页");
  if (!nextPage) throw new Error("下一页按钮未显示");

  mousedown(nextPage);

  expect(onClose).not.toHaveBeenCalled();
});

it("still closes when clicking an ordinary outside target", async () => {
  const onClose = vi.fn();
  await renderPeek(onClose);

  mousedown(outsideTarget);

  expect(onClose).toHaveBeenCalledOnce();
});
