// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CustomSearchSelect } from "@plane/ui";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });

function Harness() {
  const [value, setValue] = useState("current");

  return (
    <>
      <CustomSearchSelect
        value={value}
        onChange={setValue}
        customButton={<span>Current project</span>}
        options={[
          { value: "current", query: "current project", content: "Current project" },
          { value: "next", query: "next project", content: "Next project" },
        ]}
      />
      <output>{value}</output>
    </>
  );
}

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
  document.body.querySelectorAll("[role='listbox']").forEach((element) => element.remove());
});

it("commits a portal-rendered option", async () => {
  await act(async () => root.render(<Harness />));

  const trigger = container.querySelector<HTMLButtonElement>("button");
  await act(async () => trigger?.click());

  const option = [...document.body.querySelectorAll<HTMLElement>("[role='option']")].find(
    (element) => element.textContent === "Next project"
  );
  expect(option).toBeTruthy();

  await act(async () => option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));

  expect(container.querySelector("output")?.textContent).toBe("next");
});

it("commits an option through a complete pointer click", async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => container.querySelector<HTMLButtonElement>("button")?.click());

  const option = [...document.body.querySelectorAll<HTMLElement>("[role='option']")].find(
    (element) => element.textContent === "Next project"
  );
  expect(option).toBeTruthy();
  await act(async () => {
    option?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    option?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    option?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });

  expect(container.querySelector("output")?.textContent).toBe("next");
});
