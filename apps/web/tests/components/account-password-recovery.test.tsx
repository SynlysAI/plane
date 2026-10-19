// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ForgotPasswordPopover } from "@/components/account/auth-forms/forgot-password-popover";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const writeText = vi.fn();

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("opens administrator contact details with the entered account and an encoded email body", async () => {
  await act(async () => root.render(<ForgotPasswordPopover email="member+lab@example.com" />));
  expect(container.textContent).not.toContain("fangyikai@xmu.edu.cn");
  await act(async () => container.querySelector("button")!.click());
  const link = container.querySelector("a")!;
  expect(link.href).toContain("mailto:fangyikai@xmu.edu.cn");
  expect(decodeURIComponent(link.href)).toContain("member+lab@example.com");
  expect(container.textContent).toContain("核验身份");
  const copy = [...container.querySelectorAll("button")].find((button) => button.textContent === "复制求助信息")!;
  await act(async () => copy.click());
  expect(writeText).toHaveBeenCalledWith(expect.stringContaining("member+lab@example.com"));
  expect(container.textContent).toContain("已复制");
});

it("supports a forgotten email and lets users manually copy when clipboard access fails", async () => {
  writeText.mockRejectedValue(new Error("clipboard denied"));
  await act(async () => root.render(<ForgotPasswordPopover />));
  await act(async () => container.querySelector("button")!.click());
  await act(async () =>
    [...container.querySelectorAll("button")].find((button) => button.textContent === "复制求助信息")!.click()
  );
  expect(container.querySelector("textarea")?.value).toContain("登录邮箱：不记得");
  expect(container.textContent).toContain("姓名");
});
