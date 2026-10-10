import { expect, it } from "vitest";

import {
  collectBlockedIds,
  flattenCategories,
  projectHref,
} from "@/components/research/navigation/research-project-tree.utils";
import type { TNavigationCategory } from "@/services/research/navigation.service";

const child: TNavigationCategory = {
  id: "child",
  name: "子分类",
  kind: "CUSTOM",
  scope: "ADMINISTRATIVE",
  parent: "root",
  sort_order: 1,
  projects: [],
  children: [],
  can_manage: true,
  org_unit: null,
};

const customRoot: TNavigationCategory = {
  id: "root",
  name: "采购与资产",
  kind: "CUSTOM",
  scope: "ADMINISTRATIVE",
  parent: null,
  sort_order: 1,
  projects: [],
  children: [child],
  can_manage: true,
  org_unit: null,
};

const orgRoot: TNavigationCategory = {
  id: "org:unit-id",
  name: "分子材料组",
  kind: "ORG",
  scope: "RESEARCH",
  parent: null,
  sort_order: 0,
  projects: [],
  children: [customRoot],
  can_manage: false,
  org_unit: null,
};

it("flattens custom categories while excluding read-only org projection nodes", () => {
  const flat = flattenCategories([orgRoot]);
  expect(flat.map(({ category, depth }) => [category.id, depth])).toEqual([
    ["root", 1],
    ["child", 2],
  ]);
});

it("blocks a category and its descendants as deletion targets", () => {
  expect(collectBlockedIds(customRoot)).toEqual(new Set(["root", "child"]));
});

it("keeps the existing research and administrative project routes", () => {
  expect(projectHref("ws", { id: "project-1", kind: "RESEARCH_CHAIN" })).toBe("/ws/research/chains/project-1");
  expect(projectHref("ws", { id: "project-1", kind: "LEGACY_RESEARCH" })).toBe(
    "/ws/research/projects/project-1/stages"
  );
  expect(projectHref("ws", { id: "project-1", kind: "TEAM_RESEARCH" })).toBe("/ws/projects/project-1/issues");
  expect(projectHref("ws", { id: "project-1", kind: "ADMINISTRATIVE" })).toBe("/ws/projects/project-1/issues");
});
