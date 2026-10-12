// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ListFilterField, ListFilterInput, ListFilterSelect, ListFilterCheckbox } from "@plane/ui";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });
const container = document.createElement("div");
const root = createRoot(container);
document.body.append(container);
afterEach(async () => {
  await act(async () => root.render(null));
});

it("associates filter labels with native controls and preserves select changes", async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <ListFilterField label="状态">
        <ListFilterSelect defaultValue="" onChange={onChange}>
          <option value="">全部状态</option>
          <option value="ACTIVE">进行中</option>
        </ListFilterSelect>
      </ListFilterField>
    )
  );
  const select = container.querySelector("select")!;
  expect(select.labels?.[0]?.textContent).toContain("状态");
  await act(async () => {
    select.value = "ACTIVE";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledOnce();
  expect(select.value).toBe("ACTIVE");
});

it("forwards input refs and disabled state", async () => {
  const ref = React.createRef<HTMLInputElement>();
  await act(async () =>
    root.render(
      <ListFilterField label="关键词">
        <ListFilterInput ref={ref} disabled defaultValue="材料" />
      </ListFilterField>
    )
  );
  expect(ref.current).toBe(container.querySelector("input"));
  expect(ref.current?.disabled).toBe(true);
  expect(ref.current?.value).toBe("材料");
  expect(ref.current?.labels?.[0]?.textContent).toBe("关键词");
});

it("preserves checkbox changes and file input attributes", async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <>
        <ListFilterCheckbox label="启用" onChange={onChange} />
        <ListFilterField label="成员名册">
          <ListFilterInput type="file" accept=".csv,.xlsx" disabled />
        </ListFilterField>
      </>
    )
  );
  const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  expect(checkbox.labels?.[0]?.textContent).toBe("启用");
  await act(async () => checkbox.click());
  expect(checkbox.checked).toBe(true);
  expect(onChange).toHaveBeenCalledOnce();
  const file = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  expect(file.accept).toBe(".csv,.xlsx");
  expect(file.disabled).toBe(true);
});
