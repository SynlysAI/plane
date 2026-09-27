import { expect, it } from "vitest";
import { buildOrgTree } from "@/components/research/settings/org/org-tree";
import type { TOrgUnit } from "@plane/types";

function unit(partial: Pick<TOrgUnit, "id" | "name" | "parent" | "unit_type">): TOrgUnit {
  return {
    path: "/",
    depth: partial.parent ? 1 : 0,
    business_category: null,
    sort_order: 1,
    is_active: true,
    created_at: "2026-09-27T00:00:00Z",
    updated_at: "2026-09-27T00:00:00Z",
    ...partial,
  };
}

it("renders the root before parentless non-root nodes", () => {
  const tree = buildOrgTree([
    unit({ id: "orphan", name: "Phase 1.5 基础研究验证单元", parent: null, unit_type: "TEAM" }),
    unit({ id: "root", name: "π-Lab", parent: null, unit_type: "ROOT" }),
    unit({ id: "team", name: "器件", parent: "root", unit_type: "TEAM" }),
  ]);
  expect(tree.map((node) => node.id)).toEqual(["root", "orphan"]);
  expect(tree[0]?.children.map((node) => node.id)).toEqual(["team"]);
});
