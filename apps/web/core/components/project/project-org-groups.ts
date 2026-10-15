/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { TProject } from "@plane/types";

export type TProjectOrganizationOption = { id: string; name: string; is_default: boolean };
export type TProjectOrganizationGroup = { id: string | null; name: string; projectIds: string[] };

export const UNGROUPED_ORGANIZATION_NAME = "未分组";

/**
 * 将行政项目按组织分组：公共置首，其余按名称排序，未分组置尾。
 *
 * @param projectIds 已过滤的项目 ID 列表。
 * @param getProjectById 按 ID 获取项目的函数。
 * @param organizations 当前用户可见的行政组织列表。
 * @returns 非空且有序的项目分组。
 */
export function groupProjectsByOrganization(
  projectIds: string[],
  getProjectById: (projectId: string) => TProject | undefined,
  organizations: TProjectOrganizationOption[]
): TProjectOrganizationGroup[] {
  const buckets = new Map<string | null, string[]>();
  const visibleOrganizationIds = new Set(organizations.map((organization) => organization.id));

  for (const projectId of projectIds) {
    const organizationId = getProjectById(projectId)?.administrative_organization ?? null;
    const bucketKey = organizationId && visibleOrganizationIds.has(organizationId) ? organizationId : null;
    buckets.set(bucketKey, [...(buckets.get(bucketKey) ?? []), projectId]);
  }

  const namedOrganizations = organizations.filter((organization) => !organization.is_default);
  // 只排序局部副本，避免依赖当前 TS lib 尚未包含的 toSorted。
  namedOrganizations.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
  const orderedOrganizations = [
    ...organizations.filter((organization) => organization.is_default),
    ...namedOrganizations,
  ];

  const groups: TProjectOrganizationGroup[] = [];
  for (const organization of orderedOrganizations) {
    const groupedProjectIds = buckets.get(organization.id);
    if (groupedProjectIds?.length) {
      groups.push({ id: organization.id, name: organization.name, projectIds: groupedProjectIds });
    }
  }
  const ungroupedProjectIds = buckets.get(null);
  if (ungroupedProjectIds?.length) {
    groups.push({ id: null, name: UNGROUPED_ORGANIZATION_NAME, projectIds: ungroupedProjectIds });
  }
  return groups;
}
