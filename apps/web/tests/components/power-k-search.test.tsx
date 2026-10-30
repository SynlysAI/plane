// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Command } from "cmdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import translations from "../../../../packages/i18n/src/locales/zh-CN/power-k.json";
import type { IWorkspaceProjectSearchResult, IWorkspaceSearchResults } from "@plane/types";

const mocks = vi.hoisted(() => ({
  searchWorkspace: vi.fn(),
  togglePowerKModal: vi.fn(),
  push: vi.fn(),
}));

vi.mock("mobx-react", () => ({
  enableStaticRendering: vi.fn(),
  observer: (component: unknown) => component,
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceSlug: "lab" }),
}));
vi.mock("@/hooks/use-app-router", () => ({ useAppRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/store/use-power-k", () => ({
  usePowerK: () => ({ togglePowerKModal: mocks.togglePowerKModal }),
}));
vi.mock("@/hooks/use-debounce", () => ({ default: (value: string) => value }));
vi.mock("@/services/workspace.service", () => ({
  WorkspaceService: class {
    searchWorkspace = mocks.searchWorkspace;
  },
}));
vi.mock("@/components/power-k/ui/modal/command-item", () => ({
  PowerKModalCommandItem: ({ label, onSelect }: { label: React.ReactNode; onSelect: () => void }) => (
    <button type="button" onClick={onSelect}>
      {label}
    </button>
  ),
}));
vi.mock("@/components/issues/issue-detail/issue-identifier", () => ({
  IssueIdentifier: () => null,
}));
vi.mock("@plane/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => {
      const literal = key
        .split(".")
        .reduce<unknown>((current, part) => (current as Record<string, unknown>)?.[part], translations);
      const text = typeof literal === "string" ? literal : key;
      if (!values) return text;
      return Object.entries(values).reduce(
        (result, [name, value]) => result.replaceAll(`{${name}}`, String(value)),
        text
      );
    },
  }),
}));

const { PowerKModalSearchMenu } = await import("@/components/power-k/ui/modal/search-menu");
const { POWER_K_SEARCH_RESULTS_GROUPS_MAP } = await import("@/components/power-k/ui/modal/search-results-map");
const { PowerKModalSearchResults } = await import("@/components/power-k/ui/modal/search-results");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function projectResult(overrides: Partial<IWorkspaceProjectSearchResult>): IWorkspaceProjectSearchResult {
  return {
    id: "project-1",
    identifier: "RSCH",
    name: "科研项目",
    workspace__slug: "lab",
    route_kind: "ADMINISTRATIVE",
    chain_id: null,
    ...overrides,
  };
}

function searchResults(project: IWorkspaceProjectSearchResult): IWorkspaceSearchResults {
  return {
    results: {
      workspace: [],
      project: [project],
      issue: [],
      cycle: [],
      module: [],
      issue_view: [],
      page: [],
    },
  };
}

it("routes each research and administrative project result to its product entry", () => {
  const projectPath = POWER_K_SEARCH_RESULTS_GROUPS_MAP.project.path;

  expect(
    projectPath(projectResult({ id: "project-1", route_kind: "RESEARCH_CHAIN", chain_id: "chain-1" }), undefined)
  ).toBe("/lab/research/chains/chain-1?tab=overview");
  expect(projectPath(projectResult({ id: "project-2", route_kind: "RESEARCH_CHAIN", chain_id: null }), undefined)).toBe(
    "/lab/research/chains/project-2?tab=overview"
  );
  expect(projectPath(projectResult({ id: "project-3", route_kind: "TEAM_RESEARCH" }), undefined)).toBe(
    "/lab/research/projects/project-3/overview"
  );
  expect(projectPath(projectResult({ id: "project-4", route_kind: "LEGACY_RESEARCH" }), undefined)).toBe(
    "/lab/research/projects/project-4/overview"
  );
  expect(projectPath(projectResult({ id: "project-5", route_kind: "ADMINISTRATIVE" }), undefined)).toBe(
    "/lab/projects/project-5/issues/"
  );
});

it("renders project results and closes the palette before navigation", async () => {
  const closePalette = vi.fn();
  await act(async () =>
    root.render(
      <Command>
        <PowerKModalSearchResults
          closePalette={closePalette}
          results={searchResults(
            projectResult({ name: "产业化课题", route_kind: "RESEARCH_CHAIN", chain_id: "chain-1" })
          )}
        />
      </Command>
    )
  );

  await act(async () => container.querySelector("button")?.click());

  expect(closePalette).toHaveBeenCalledTimes(1);
  expect(mocks.push).toHaveBeenCalledWith("/lab/research/chains/chain-1?tab=overview");
});

it("calls the unified workspace search with stable scope parameters", async () => {
  mocks.searchWorkspace.mockResolvedValue({
    results: { workspace: [], project: [], issue: [], cycle: [], module: [], issue_view: [], page: [] },
  });

  await act(async () =>
    root.render(
      <Command>
        <PowerKModalSearchMenu
          activePage={null}
          context={{} as never}
          isWorkspaceLevel
          searchTerm="产业化"
          updateSearchTerm={vi.fn()}
        />
      </Command>
    )
  );
  await act(async () => undefined);

  expect(mocks.searchWorkspace).toHaveBeenCalledWith("lab", {
    search: "产业化",
    workspace_search: true,
  });
});

it("shows a localized search failure instead of a false no-result state", async () => {
  mocks.searchWorkspace.mockRejectedValue(new Error("search unavailable"));

  await act(async () =>
    root.render(
      <Command>
        <PowerKModalSearchMenu
          activePage={null}
          context={{} as never}
          isWorkspaceLevel
          searchTerm="产业化"
          updateSearchTerm={vi.fn()}
        />
      </Command>
    )
  );
  await act(async () => undefined);

  expect(container.textContent).toContain("在“产业化”的工作区搜索结果：");
  expect(container.textContent).toContain("搜索失败，请稍后重试。");
  expect(container.textContent).not.toContain("未找到结果");
});
