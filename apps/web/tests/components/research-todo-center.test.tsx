// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/common.json";

const mocks = vi.hoisted(() => ({
  getResearchTodos: vi.fn(),
}));

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const literal = key
        .split(".")
        .reduce<unknown>((entry, part) => (entry as Record<string, unknown>)?.[part], translations);
      const text = typeof literal === "string" ? literal : key;
      if (!values) return text;
      return Object.entries(values).reduce(
        (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
        text
      );
    },
    currentLocale: "zh-CN",
  }),
}));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@/services/research/research-todo.service", () => ({
  ResearchTodoService: class {
    getResearchTodos = mocks.getResearchTodos;
  },
}));

const WorkspaceResearchTodosPage = (await import("../../app/(all)/[workspaceSlug]/(projects)/research/todos/page"))
  .default;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderPage() {
  return act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/todos"]}>
        <Routes>
          <Route path="/:workspaceSlug/research/todos" element={<WorkspaceResearchTodosPage />} />
        </Routes>
      </MemoryRouter>
    )
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.getResearchTodos.mockResolvedValue({
    schema_version: "research-todo.v2",
    results: [
      {
        schema_version: "research-todo.v2" as const,
        id: "REPORT:report-1",
        source: "REPORT" as const,
        object_id: "report-1",
        title: "报告需修订 · 2026-W38",
        context: "高分子课题 / 周报",
        requester: { id: "student-1", display_name: "学生一" },
        assignees: [{ id: "advisor-1", display_name: "导师一" }],
        business_status: "NEEDS_REVISION",
        urgency: "NORMAL" as const,
        handling_status: "RETURNED" as const,
        next_action: "SUBMIT" as const,
        due_at: null,
        href: "/lab/research/reports/report-1",
        capabilities: { schema_version: "research-capabilities.v1" as const, actions: {} },
        trace_ref: null,
        updated_at: "2026-10-09T00:00:00Z",
      },
    ],
    count: 1,
    total_count: 1,
    next_cursor: null,
    degraded_sources: [],
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it("renders the cross-component todo center with the full list and home back link", async () => {
  await renderPage();
  await act(async () => undefined);

  expect(mocks.getResearchTodos).toHaveBeenCalledWith("lab", { scope: "to_me", limit: 100 });
  expect(container.textContent).toContain("跨组件待办");
  expect(container.textContent).toContain("报告需修订 · 2026-W38");
  expect(container.textContent).toContain("共 1 条");
  expect(container.querySelector('a[href="/lab"]')).not.toBeNull();
  expect(container.querySelector('a[href="/lab/research/reports/report-1"]')).not.toBeNull();
});
