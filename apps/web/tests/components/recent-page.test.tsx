// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TActivityEntityData } from "@plane/types";

const routerPush = vi.fn();
const listItemProps: { itemLink: string; onItemClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void }[] = [];

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock("@makeplane/propel/components/avatar", () => ({ Avatar: () => <span aria-label="owner" /> }));
vi.mock("@plane/propel/emoji-icon-picker", () => ({ Logo: () => <span aria-label="page-logo" /> }));
vi.mock("@plane/icons", () => ({ PagesOutline: () => <span aria-label="page-icon" /> }));
vi.mock("@plane/utils", () => ({
  calculateTimeAgo: () => "less than a minute ago",
  getFileURL: () => "",
  getPageName: (name: string) => name,
}));
vi.mock("@/components/core/list", () => ({
  ListItem: (props: {
    title: string;
    itemLink: string;
    prependTitleElement: React.ReactNode;
    onItemClick?: (event: React.MouseEvent<HTMLAnchorElement>) => void;
  }) => {
    listItemProps.push(props);
    return (
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
    );
  },
}));
vi.mock("@/hooks/store/use-member", () => ({
  useMember: () => ({ getUserDetails: () => ({ display_name: "页面负责人", avatar_url: "" }) }),
}));

const { RecentPage } = await import("@/components/home/widgets/recents/page");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  listItemProps.length = 0;
  routerPush.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("renders the page name without the project identifier and keeps navigation", async () => {
  const activity = {
    id: "recent-page",
    entity_name: "page",
    entity_identifier: "page-id",
    visited_at: "2026-10-20T08:00:00Z",
    entity_data: {
      id: "page-id",
      name: "页面标题",
      logo_props: {},
      project_id: "project-id",
      owned_by: "owner-id",
      project_identifier: "PRJA121C6",
    },
  } as unknown as TActivityEntityData;
  const parentRef = { current: document.createElement("div") };

  await act(async () => root.render(<RecentPage activity={activity} ref={parentRef} workspaceSlug="lab" />));
  await act(async () => container.querySelector("button")?.click());

  expect(container.textContent).toContain("页面标题");
  expect(container.textContent).not.toContain("PRJA121C6");
  expect(listItemProps.at(-1)?.itemLink).toBe("/lab/projects/project-id/pages/page-id");
  expect(routerPush).toHaveBeenCalledWith("/lab/projects/project-id/pages/page-id");
});
