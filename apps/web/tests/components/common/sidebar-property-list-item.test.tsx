// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SidebarPropertyListItem } from "@/components/common/layout/sidebar/property-list-item";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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

it("stacks an administrative property label above its value in a narrow detail dock", async () => {
  await act(async () =>
    root.render(
      <SidebarPropertyListItem icon={() => <svg aria-hidden />} label="创建人">
        <span>方奕凯</span>
      </SidebarPropertyListItem>
    )
  );

  const row = container.querySelector<HTMLElement>("[data-sidebar-property-list-item]");
  const label = container.querySelector<HTMLElement>("[data-sidebar-property-label]");
  const value = container.querySelector<HTMLElement>("[data-sidebar-property-value]");
  expect(row?.className).toContain("@max-md:flex-col");
  expect(label?.className).toContain("@max-md:w-full");
  expect(label?.className).not.toContain("truncate");
  expect(value?.className).toContain("@max-md:w-full");
  expect(value?.className).toContain("flex-wrap");
});
