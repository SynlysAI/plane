import { API_BASE_URL, researchEndpoints } from "@plane/constants";
import { APIService } from "@/services/api.service";

export type TNavigationScope = "RESEARCH" | "ADMINISTRATIVE";
export type TNavigationProject = {
  id: string;
  chain_id?: string | null;
  name: string;
  identifier: string;
  kind: "RESEARCH_CHAIN" | "TEAM_RESEARCH" | "LEGACY_RESEARCH" | "ADMINISTRATIVE";
};
export type TNavigationCategory = {
  id: string;
  name: string;
  kind: "CUSTOM" | "ORG";
  scope: TNavigationScope;
  parent: string | null;
  sort_order: number;
  projects: TNavigationProject[];
  children: TNavigationCategory[];
  can_manage: boolean;
  org_unit: string | null;
};
export type TNavigationTree = {
  scope: TNavigationScope;
  can_manage: boolean;
  categories: TNavigationCategory[];
  uncategorized: TNavigationProject[];
};
export type TAdministrativeOrganization = {
  id: string;
  name: string;
  is_default: boolean;
  can_manage: boolean;
  created_by: string | null;
  members: { id: string; name: string; email: string; role: "ADMIN" | "MEMBER" }[];
  project_ids: string[];
};
export type TAssignableOrganizationMember = { id: string; name: string; email: string };
export type TNavigationCategoryPayload = {
  scope: TNavigationScope;
  name: string;
  parent?: string | null;
  org_unit?: string | null;
  sort_order?: number;
};
export type TNavigationCategoryMutationResult = Pick<
  TNavigationCategory,
  "id" | "name" | "scope" | "parent" | "sort_order" | "org_unit"
>;

export class ResearchNavigationService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  /** 获取一个项目通道的分类树和可见项目。 */
  async getTree(workspaceSlug: string, scope: TNavigationScope): Promise<TNavigationTree> {
    return this.get(researchEndpoints.navigationCategories(workspaceSlug), { params: { scope } })
      .then((res) => res?.data as TNavigationTree)
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  /** 创建分类；组织锚点仅用于科研根分类。 */
  async createCategory(
    workspaceSlug: string,
    payload: TNavigationCategoryPayload
  ): Promise<TNavigationCategoryMutationResult> {
    return this.post(researchEndpoints.navigationCategories(workspaceSlug), payload).then((res) => res?.data);
  }

  /** 编辑分类名称、父级或排序。 */
  async updateCategory(
    workspaceSlug: string,
    categoryId: string,
    payload: Partial<TNavigationCategoryPayload>
  ): Promise<TNavigationCategoryMutationResult> {
    return this.patch(researchEndpoints.navigationCategory(workspaceSlug, categoryId), payload).then(
      (res) => res?.data
    );
  }

  /** 删除分类；非空分类必须显式指定迁移目标。 */
  async deleteCategory(workspaceSlug: string, categoryId: string, moveTo?: string | null): Promise<void> {
    return this.delete(researchEndpoints.navigationCategory(workspaceSlug, categoryId), {
      params: moveTo ? { move_to: moveTo } : undefined,
    }).then(() => undefined);
  }

  /** 只改变项目导航关联，不改变成员或权限。 */
  async moveProject(
    workspaceSlug: string,
    projectId: string,
    scope: TNavigationScope,
    category: string | null
  ): Promise<{ project_id: string; category: string | null }> {
    return this.post(researchEndpoints.navigationProjectMove(workspaceSlug, projectId), { scope, category }).then(
      (res) => res?.data
    );
  }

  /** 获取行政组织及其成员、项目归属。 */
  async getAdministrativeOrganizations(workspaceSlug: string): Promise<TAdministrativeOrganization[]> {
    return this.get(researchEndpoints.administrativeOrganizations(workspaceSlug))
      .then((res) => res?.data as TAdministrativeOrganization[])
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  /** 创建行政组织。 */
  async createAdministrativeOrganization(workspaceSlug: string, name: string) {
    return this.post(researchEndpoints.administrativeOrganizations(workspaceSlug), { name }).then(
      (res) => res?.data as TAdministrativeOrganization
    );
  }

  /** 重命名非默认行政组织。 */
  async updateAdministrativeOrganization(workspaceSlug: string, organizationId: string, name: string) {
    return this.patch(researchEndpoints.administrativeOrganization(workspaceSlug, organizationId), {
      name,
    }).then((res) => res?.data as TAdministrativeOrganization);
  }

  /** 删除组织，并将项目迁移到显式选择的目标组织。 */
  async deleteAdministrativeOrganization(workspaceSlug: string, organizationId: string, moveTo: string): Promise<void> {
    return this.delete(researchEndpoints.administrativeOrganization(workspaceSlug, organizationId), {
      params: { move_to: moveTo },
    }).then(() => undefined);
  }

  /** 添加组织成员并授予组织成员或管理员角色。 */
  async addAdministrativeOrganizationMember(
    workspaceSlug: string,
    organizationId: string,
    member: string,
    role: "ADMIN" | "MEMBER" = "MEMBER"
  ) {
    return this.post(researchEndpoints.administrativeOrganizationMembers(workspaceSlug, organizationId), {
      member,
      role,
    }).then((res) => res?.data);
  }

  /** 调整组织成员角色。 */
  async updateAdministrativeOrganizationMember(
    workspaceSlug: string,
    organizationId: string,
    memberId: string,
    role: "ADMIN" | "MEMBER"
  ) {
    return this.patch(researchEndpoints.administrativeOrganizationMember(workspaceSlug, organizationId, memberId), {
      role,
    }).then((res) => res?.data);
  }

  /** 移除组织成员并撤销其继承访问。 */
  async removeAdministrativeOrganizationMember(
    workspaceSlug: string,
    organizationId: string,
    memberId: string
  ): Promise<void> {
    return this.delete(
      researchEndpoints.administrativeOrganizationMember(workspaceSlug, organizationId, memberId)
    ).then(() => undefined);
  }

  /** 获取尚未加入组织的工作区成员。 */
  async getAssignableAdministrativeOrganizationMembers(
    workspaceSlug: string,
    organizationId: string
  ): Promise<TAssignableOrganizationMember[]> {
    return this.get(researchEndpoints.administrativeOrganizationAssignableMembers(workspaceSlug, organizationId))
      .then((res) => res?.data as TAssignableOrganizationMember[])
      .catch((err) => {
        throw err?.response?.data;
      });
  }

  /** 变更行政项目组织归属。 */
  async moveAdministrativeProject(workspaceSlug: string, projectId: string, organization: string | null) {
    return this.post(researchEndpoints.administrativeProjectOrganization(workspaceSlug, projectId), {
      organization,
    });
  }
}
