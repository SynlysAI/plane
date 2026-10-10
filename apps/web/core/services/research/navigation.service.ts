import { API_BASE_URL, researchEndpoints } from "@plane/constants";
import { APIService } from "@/services/api.service";

export type TNavigationScope = "RESEARCH" | "ADMINISTRATIVE";
export type TNavigationProject = {
  id: string;
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
}
