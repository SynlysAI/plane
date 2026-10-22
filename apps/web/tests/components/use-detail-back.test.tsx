// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("react-router", () => ({ useNavigate: () => navigate }));

const { useDetailBack } = await import("@/hooks/use-detail-back");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const originalState = window.history.state;

/** 覆盖 jsdom 的 history.state 以模拟 React Router 的历史索引。 */
const setHistoryState = (state: unknown) => {
  Object.defineProperty(window.history, "state", { value: state, configurable: true });
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  navigate.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setHistoryState(originalState);
});

/** 在组件顶层调用返回 hook，渲染可点击按钮。 */
function BackButton() {
  const handleBack = useDetailBack("/lab/projects/project-id/issues");
  return (
    <button type="button" onClick={handleBack}>
      back
    </button>
  );
}

const renderBackButton = () => root.render(<BackButton />);

it("goes back through browser history when a previous entry exists", async () => {
  setHistoryState({ idx: 2 });

  await act(async () => renderBackButton());
  await act(async () => container.querySelector("button")?.click());

  expect(navigate).toHaveBeenCalledWith(-1);
});

it("falls back to the fixed list route when opened directly without history", async () => {
  setHistoryState({ idx: 0 });

  await act(async () => renderBackButton());
  await act(async () => container.querySelector("button")?.click());

  expect(navigate).toHaveBeenCalledWith("/lab/projects/project-id/issues");
});

it("falls back to the fixed list route when history state is missing", async () => {
  setHistoryState(null);

  await act(async () => renderBackButton());
  await act(async () => container.querySelector("button")?.click());

  expect(navigate).toHaveBeenCalledWith("/lab/projects/project-id/issues");
});
