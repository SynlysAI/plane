/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TOrgUnit } from "@plane/types";

export type OrgTreeNode = TOrgUnit & { children: OrgTreeNode[] };

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
