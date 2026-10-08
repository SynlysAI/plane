// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), createOutcome: vi.fn() }));
vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/research/common/browse-filters", () => ({ ResearchBrowseFilters: () => null }));
vi.mock("@/hooks/store/use-research", () => ({
  useResearch: () => ({
    fetchOrgUnits: vi.fn().mockResolvedValue([]),
    getOrgUnits: () => [],
  }),
}));
vi.mock("@plane/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@plane/propel/button", () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}));
vi.mock("@plane/ui", () => ({
  ModalCore: ({ children }: { children: React.ReactNode }) => <div role="dialog">{children}</div>,
}));
vi.mock("@/services/research/outcome.service", () => ({
  ResearchOutcomeService: class {
    get = mocks.get;
    createOutcome = mocks.createOutcome;
  },
}));

const { WorkspaceOutcomes } = await import("@/components/research/outcomes/workspace-outcomes");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** Render the workspace outcome view with one visible published result. */
async function renderOutcomes() {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/lab/research/reports?view=outcomes"]}>
        <WorkspaceOutcomes workspaceSlug="lab" />
      </MemoryRouter>
    )
  );
}

/** Find a button by visible text. */
function button(label: string) {
  const target = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label);
  if (!target) throw new Error(`未找到按钮：${label}`);
  return target;
}

/** Set a controlled input through the native value setter used by React. */
async function setInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mocks.get.mockResolvedValue({
    data: {
      results: [
        {
          id: "outcome-1",
          project: "project-1",
          title: "Graphite paper",
          output_type: "PAPER",
          status: "PUBLISHED",
          venue: "Nature",
          doi: "10.1000/example",
          published_at: "2026-10-03",
          visibility: "WORKSPACE",
          links: [],
          attachments: [],
          created_at: "2026-10-08T00:00:00Z",
        },
      ],
      next_cursor: "",
      prev_cursor: "",
      next_page_results: false,
      prev_page_results: false,
      create_projects: [{ id: "project-1", name: "Graphite project" }],
    },
  });
  mocks.createOutcome.mockResolvedValue({});
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it("成果表格显示发表日期，登记弹窗提交完整字段", async () => {
  await renderOutcomes();
  expect(container.textContent).toContain("发表/授权日期");
  expect(container.textContent).toContain("2026-10-03");

  await act(async () => button("登记成果").click());
  const title = container.querySelector<HTMLInputElement>('input[aria-label="成果名称"]');
  const publishedAt = container.querySelector<HTMLInputElement>('input[aria-label="发表/授权日期"]');
  const venue = container.querySelector<HTMLInputElement>('input[aria-label="期刊/会议"]');
  const doi = container.querySelector<HTMLInputElement>('input[aria-label="DOI"]');
  if (!title || !publishedAt || !venue || !doi) throw new Error("成果字段未显示");

  await setInput(title, "Later publication");
  await setInput(publishedAt, "2026-10-04");
  await setInput(venue, "Science");
  await setInput(doi, "10.1000/later");
  await act(async () => button("登记").click());

  expect(mocks.createOutcome).toHaveBeenCalledWith("lab", "project-1", {
    title: "Later publication",
    output_type: "PAPER",
    status: "DRAFT",
    published_at: "2026-10-04",
    venue: "Science",
    doi: "10.1000/later",
  });
});

it("登记失败时错误保留在弹窗内", async () => {
  mocks.createOutcome.mockRejectedValue(new Error("forbidden"));
  await renderOutcomes();
  await act(async () => button("登记成果").click());
  const title = container.querySelector<HTMLInputElement>('input[aria-label="成果名称"]');
  if (!title) throw new Error("成果名称未显示");
  await setInput(title, "Forbidden publication");
  await act(async () => button("登记").click());

  expect(container.querySelector('[role="alert"]')?.textContent).toContain("成果登记失败");
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
});
