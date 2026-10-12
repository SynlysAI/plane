// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "research.todo.urgency.overdue": "逾期",
        "research.todo.urgency.today": "今天截止",
        "research.todo.urgency.soon": "即将截止",
        "research.todo.urgency.normal": "正常",
      })[key] ?? key,
    currentLocale: "zh-CN",
  }),
}));

const { ResearchTodoUrgency } = await import("@/components/research/common/research-todo-urgency");
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

it("renders textual overdue and countdown state without relying on color", async () => {
  await act(async () =>
    root.render(
      <>
        <ResearchTodoUrgency dueAt="2026-10-09T08:00:00Z" now="2026-10-09T10:00:00Z" />
        <ResearchTodoUrgency dueAt="2026-10-09T18:30:00" now="2026-10-09T10:00:00" />
        <ResearchTodoUrgency dueAt="2026-10-11T12:00:00" now="2026-10-09T10:00:00" />
        <ResearchTodoUrgency dueAt="2026-10-20T12:00:00" now="2026-10-09T10:00:00" />
      </>
    )
  );

  expect(container.textContent).toContain("逾期 2 小时");
  expect(container.textContent).toContain("今天截止 18:30");
  expect(container.textContent).toContain("即将截止 剩 2 天");
  expect(container.textContent).toContain("正常");
});
