/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TOrgUnit } from "@plane/types";

export type OrgTreeNode = TOrgUnit & { children: OrgTreeNode[] };

/**
 * Resolve the direction node that owns a unit after its business category
 * changes. Direction nodes are the immediate children of the single root;
 * keeping this lookup here makes the editor use the same tree model as the
 * renderer.
 */
export function findBusinessCategoryParent(
  units: TOrgUnit[],
  unit: TOrgUnit,
  businessCategory: TOrgUnit["business_category"]
): string | undefined {
  if (!businessCategory || !["GROUP", "TEAM"].includes(unit.unit_type)) return undefined;

  const root = units.find((candidate) => candidate.unit_type === "ROOT" && candidate.parent === null);
  if (!root) return undefined;

  return units.find(
    (candidate) =>
      candidate.id !== unit.id && candidate.parent === root.id && candidate.business_category === businessCategory
  )?.id;
}

/** 只把根节点放在树顶，父节点为空的非根节点排在后面。 */
export function buildOrgTree(units: TOrgUnit[]): OrgTreeNode[] {
  const nodes = new Map<string, OrgTreeNode>();
  units.forEach((unit) => nodes.set(unit.id, { ...unit, children: [] }));
  const roots: OrgTreeNode[] = [];
  const anomalies: OrgTreeNode[] = [];
  units.forEach((unit) => {
    const node = nodes.get(unit.id);
    if (!node) return;
    if (unit.parent && nodes.has(unit.parent)) {
      nodes.get(unit.parent)?.children.push(node);
      return;
    }
    if (unit.unit_type === "ROOT") roots.push(node);
    else anomalies.push(node);
  });
  return [...roots, ...anomalies];
}
