// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TActivityEntityData } from "@plane/types";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@plane/utils", () => ({ calculateTimeAgo: () => "5 minutes ago" }));
vi.mock("@plane/propel/emoji-icon-picker", () => ({ Logo: () => <span aria-label="project-logo" /> }));
vi.mock("@/components/core/list", () => ({
  ListItem: (props: {
    title: string;
    prependTitleElement: React.ReactNode;
    onItemClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <div>
      <span>{props.title}</span>
      <div data-testid="prepend">{props.prependTitleElement}</div>
      <button
        type="button"
        onClick={() =>
          props.onItemClick?.({
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
          } as React.MouseEvent<HTMLAnchorElement>)
        }
      >
        open
      </button>
    </div>
  ),
}));
vi.mock("@/components/dropdowns/member/dropdown", () => ({ MemberDropdown: () => null }));

const { RecentProject } = await import("@/components/home/widgets/recents/project");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  push.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

/** 构造一条最近访问的项目记录。 */
function recentProject(): TActivityEntityData {
  return {
    id: "recent-project",
    entity_name: "project",
    entity_identifier: "project-id",
    visited_at: "2026-10-20T08:00:00Z",
    entity_data: {
      id: "project-id",
      name: "科研项目",
      identifier: "PRJTEST",
      project_members: [],
      logo_props: {},
    },
  } as unknown as TActivityEntityData;
}

it("renders the project name without the internal project identifier", async () => {
  const parentRef = { current: document.createElement("div") };

  await act(async () => root.render(<RecentProject activity={recentProject()} ref={parentRef} workspaceSlug="lab" />));

  expect(container.textContent).toContain("科研项目");
  expect(container.textContent).not.toContain("PRJTEST");
});

it("navigates to the project work items list when the recent project is clicked", async () => {
  const parentRef = { current: document.createElement("div") };

  await act(async () => root.render(<RecentProject activity={recentProject()} ref={parentRef} workspaceSlug="lab" />));
  await act(async () => container.querySelector("button")?.click());

  expect(push).toHaveBeenCalledTimes(1);
  expect(push).toHaveBeenCalledWith("/lab/projects/project-id/issues");
});

it("navigates to the research chain when the project has a chain mapping", async () => {
  const parentRef = { current: document.createElement("div") };

  await act(async () =>
    root.render(
      <RecentProject
        activity={recentProject()}
        ref={parentRef}
        workspaceSlug="lab"
        researchChainByProject={{ "project-id": "chain-1" }}
      />
    )
  );
  await act(async () => container.querySelector("button")?.click());

  expect(push).toHaveBeenCalledTimes(1);
  expect(push).toHaveBeenCalledWith("/lab/research/chains/chain-1");
});
