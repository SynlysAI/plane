// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const value = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      return typeof value === "string" ? value : key;
    },
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));

const { ResearchChainStageReviewActions } =
  await import("@/components/research/chains/research-chain-stage-review-actions");

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
  vi.clearAllMocks();
});

async function renderActions(
  policy: "ADVISOR_ONLY" | "ALWAYS_PI" | "CONDITIONAL_PI",
  requiresPi: boolean,
  reviewerRole?: "ADVISOR" | "PI"
) {
  const onApprove = vi.fn();
  const onReturn = vi.fn();
  await act(async () => {
    root.render(
      <ResearchChainStageReviewActions
        policy={policy}
        requiresPi={requiresPi}
        reviewerRole={reviewerRole}
        onApprove={onApprove}
        onReturn={onReturn}
      />
    );
  });
  return { onApprove, onReturn };
}

function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label
  );
}

it("always sends an explicit escalation for fixed PI stages", async () => {
  const { onApprove } = await renderActions("ALWAYS_PI", false);
  await act(async () => button("通过并转主 PI")?.click());
  expect(onApprove).toHaveBeenCalledWith(true);
});

it("offers both explicit decisions when the student declared PI review", async () => {
  const { onApprove } = await renderActions("CONDITIONAL_PI", true);
  await act(async () => button("通过并转主 PI")?.click());
  await act(async () => button("通过（不转 PI）")?.click());
  expect(onApprove).toHaveBeenNthCalledWith(1, true);
  expect(onApprove).toHaveBeenNthCalledWith(2, false);
});

it("keeps undeclared escalation disabled", async () => {
  await renderActions("CONDITIONAL_PI", false);
  expect(button("通过（不转 PI）")?.disabled).toBe(false);
  const escalation = button("通过并转主 PI")!;
  expect(escalation.disabled).toBe(true);
  const describedBy = escalation.getAttribute("aria-describedby");
  expect(describedBy).toBeTruthy();
  expect(document.getElementById(describedBy!)?.textContent).toContain("学生未声明需要主 PI 审核，不能转主 PI");
});

it("shows a plain approval action for the principal reviewer", async () => {
  const { onApprove } = await renderActions("ALWAYS_PI", false, "PI");
  expect(button("通过并转主 PI")).toBeUndefined();
  await act(async () => button("通过")?.click());
  expect(onApprove).toHaveBeenCalledWith(false);
});
