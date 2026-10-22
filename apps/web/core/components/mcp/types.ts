/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

export type MCPTarget = {
  key: string;
  source: "admin" | "research";
  workspace: string;
  workspaceName: string;
  title: string;
  chainTitle?: string;
  nodeId?: string;
  mode: "read" | "write";
  actions: string[];
  csrf: string;
  ttlSeconds?: number;
};
export function targetVersion(target: MCPTarget) {
  const actions = [...target.actions];
  // This project targets ES2022; sort the copy without mutating selected capabilities.
  // eslint-disable-next-line unicorn/no-array-sort
  actions.sort();
  return `${target.key}:${target.mode}:${actions.join(",")}`;
}
