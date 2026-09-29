import { expect, it } from "vitest";
import { buildOrgTree, findBusinessCategoryParent } from "@/components/research/settings/org/org-tree";
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

it("resolves the direction parent when a child changes business category", () => {
  const root = unit({ id: "root", name: "π-Lab", parent: null, unit_type: "ROOT" });
  const industrialization = {
    ...unit({ id: "industrialization", name: "产业化", parent: "root", unit_type: "LAB" }),
    business_category: "INDUSTRIALIZATION" as const,
  };
  const basicResearch = {
    ...unit({ id: "basic", name: "基础研究", parent: "root", unit_type: "LAB" }),
    business_category: "BASIC_RESEARCH" as const,
  };
  const team = {
    ...unit({ id: "team", name: "电氢联储", parent: "industrialization", unit_type: "GROUP" }),
    business_category: "INDUSTRIALIZATION" as const,
  };

  expect(findBusinessCategoryParent([root, industrialization, basicResearch, team], team, "BASIC_RESEARCH")).toBe(
    "basic"
  );
  expect(
    findBusinessCategoryParent([root, industrialization, basicResearch], industrialization, "BASIC_RESEARCH")
  ).toBe(undefined);

  const rootTeam = {
    ...unit({ id: "root-team", name: "历史小组", parent: "root", unit_type: "TEAM" }),
    business_category: "INDUSTRIALIZATION" as const,
  };
  expect(
    findBusinessCategoryParent([root, industrialization, basicResearch, rootTeam], rootTeam, "BASIC_RESEARCH")
  ).toBe("basic");
});
