// @vitest-environment jsdom
import React, { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOutsideClickDetector } from "@plane/hooks";

vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const FIELDS = ["状态", "优先级", "负责人", "标签", "父项"] as const;

function CreateModalHarness({ field }: { field: string }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState("");
  useOutsideClickDetector(cardRef, () => setOpen(false), true);

  return (
    <div>
      <button type="button" data-testid="mask" className="fixed inset-0 z-30" onMouseDown={() => setOpen(false)} />
      <div ref={cardRef} className="relative z-30 h-10 w-40 overflow-hidden">
        <button type="button">{field}</button>
      </div>
      {open
        ? createPortal(
            <ul role="listbox" data-prevent-outside-click className="fixed z-40" style={{ top: 200, left: 0 }}>
              <li
                role="option"
                aria-selected={false}
                onMouseDown={() => setValue(field === "状态" ? "In Progress" : field)}
              >
                {field === "状态" ? "In Progress" : field}
              </li>
            </ul>,
            document.body
          )
        : null}
      <output>{value}</output>
      <span data-testid="open">{open ? "open" : "closed"}</span>
    </div>
  );
}

describe("work item dropdown commit", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.querySelectorAll("[data-prevent-outside-click]").forEach((node) => node.remove());
    vi.unstubAllGlobals();
  });

  it.each(FIELDS)("commits %s before the modal mask closes the menu", async (field) => {
    await act(async () => root.render(<CreateModalHarness field={field} />));
    const option = document.body.querySelector<HTMLElement>("[role='option']");
    expect(option).not.toBeNull();
    const rect = option!.getBoundingClientRect();
    expect(rect.top).toBeGreaterThanOrEqual(0);
    await act(async () => {
      option!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
    });
    expect(container.querySelector("output")?.textContent).toBe(field === "状态" ? "In Progress" : field);
    expect(container.querySelector("[data-testid='open']")?.textContent).toBe("open");
  });

  it("still closes when the press lands on the mask", async () => {
    await act(async () => root.render(<CreateModalHarness field="状态" />));
    const mask = container.querySelector<HTMLElement>("[data-testid='mask']")!;
    await act(async () => {
      mask.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector("[data-testid='open']")?.textContent).toBe("closed");
    expect(container.querySelector("output")?.textContent).toBe("");
  });
});
