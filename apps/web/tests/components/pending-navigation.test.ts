// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";

const { consumePendingNavigation, installPendingNavigationClickRecorder, recordPendingNavigation } =
  await import("@/lib/pending-navigation");

let cleanup: (() => void) | null = null;

/** 创建并触发一个真实点击事件。 */
const clickElement = (element: Element, init?: MouseEventInit) => {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
};

beforeEach(() => {
  sessionStorage.clear();
  cleanup = installPendingNavigationClickRecorder();
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  sessionStorage.clear();
});

it("records the latest internal anchor click", () => {
  const anchor = document.createElement("a");
  anchor.setAttribute("href", "/lab/projects/project-id/issues/");
  document.body.append(anchor);

  clickElement(anchor);

  expect(consumePendingNavigation()).toBe("/lab/projects/project-id/issues/");
  expect(consumePendingNavigation()).toBeNull();
});

it("records clicks on nested elements inside an anchor", () => {
  const anchor = document.createElement("a");
  anchor.setAttribute("href", "/lab/todos/");
  const label = document.createElement("span");
  label.textContent = "待办";
  anchor.append(label);
  document.body.append(anchor);

  clickElement(label);

  expect(consumePendingNavigation()).toBe("/lab/todos/");
});

it("ignores external links, hash-only links, and modified clicks", () => {
  const external = document.createElement("a");
  external.setAttribute("href", "https://example.com/");
  const hashOnly = document.createElement("a");
  hashOnly.setAttribute("href", "#section");
  const internal = document.createElement("a");
  internal.setAttribute("href", "/lab/");
  document.body.append(external, hashOnly, internal);

  clickElement(external);
  clickElement(hashOnly);
  clickElement(internal, { ctrlKey: true });

  expect(consumePendingNavigation()).toBeNull();
});

it("expires pending navigation targets after the freshness window", () => {
  recordPendingNavigation("/lab/projects/project-id/issues/");
  const originalNow = Date.now;
  Date.now = () => originalNow() + 60_000;
  try {
    expect(consumePendingNavigation()).toBeNull();
  } finally {
    Date.now = originalNow;
  }
});
