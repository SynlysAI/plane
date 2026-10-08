// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("mobx-react", () => ({ observer: (component: unknown) => component }));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({
    workspace: { fetchWorkspaceMembers: vi.fn().mockResolvedValue([]), getWorkspaceMemberIds: () => [] },
    getUserDetails: () => undefined,
  }),
}));
vi.mock("@/components/research/common/person-select", () => ({
  ResearchPersonSelect: ({ label }: { label: string }) => <output aria-label={label} />,
}));

const { ResearchBrowseFilters } = await import("@/components/research/common/browse-filters");
const { useResearchBrowseQuery } = await import("@/components/research/common/browse-query");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

/** Render one real browse-filter control against the browser URL. */
function Probe({ kind }: { kind: "reports" | "projects" | "outcomes" }) {
  const query = useResearchBrowseQuery();
  const location = useLocation();
  return (
    <>
      <ResearchBrowseFilters workspaceSlug="lab" query={query} kind={kind} />
      <output aria-label="URL">{location.search}</output>
    </>
  );
}

/** Render a probe with an explicit initial URL. */
async function renderFilters(kind: "reports" | "projects" | "outcomes", initialEntry: string) {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={[initialEntry]}>
        <Probe kind={kind} />
      </MemoryRouter>
    )
  );
}

/** Change a select through its native setter so React records controlled state. */
async function select(value: string) {
  const target = container.querySelector<HTMLSelectElement>('select[aria-label="范围"]');
  if (!target) throw new Error("范围筛选未显示");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(target, value);
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function url() {
  return new URLSearchParams(container.querySelector('output[aria-label="URL"]')?.textContent ?? "");
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.resetAllMocks();
});

it("报告筛选兼容 legacy mine 参数并保留无关页面参数", async () => {
  await renderFilters("reports", "/lab/research/reports?source=legacy&mine=true&cursor=page-2");
  const scope = container.querySelector<HTMLSelectElement>('select[aria-label="范围"]');
  expect(scope?.value).toBe("mine");

  await select("all");
  expect(url().get("source")).toBe("legacy");
  expect(url().has("mine")).toBe(false);
  expect(url().has("scope")).toBe(false);
  expect(url().has("cursor")).toBe(false);
});

it("项目范围切换写入新 scope 并清除游标", async () => {
  await renderFilters("projects", "/lab/research/projects?scope=participating&cursor=page-2");
  await select("owned");
  expect(url().get("scope")).toBe("owned");
  expect(url().has("cursor")).toBe(false);
});
