// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: React.ComponentProps<"a"> & { href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("lucide-react", () => ({ ChevronLeft: () => <span aria-hidden="true">chevron-left</span> }));

const { DetailBackLink } = await import("@/components/common/detail-back-link");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("renders a quiet fixed-parent link with accessible labeling", async () => {
  await act(async () =>
    root.render(<DetailBackLink href="/lab/projects/project/issues">返回工作项列表</DetailBackLink>)
  );

  const link = container.querySelector("a");
  expect(link?.getAttribute("href")).toBe("/lab/projects/project/issues");
  expect(link?.getAttribute("aria-label")).toBe("返回上一级菜单");
  expect(link?.textContent).toContain("chevron-left");
  expect(link?.textContent).toContain("返回工作项列表");
  expect(link?.className).toContain("text-12");
  expect(link?.className).toContain("max-w-full");
  expect(link?.className).toContain("hover:bg-surface-2");
  expect(link?.className).not.toContain("shadow");
  expect(link?.className).not.toContain("gradient");
});
