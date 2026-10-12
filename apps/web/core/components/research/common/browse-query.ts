import { useSearchParams } from "react-router";

export type TResearchBrowseCommonValues = {
  org_unit?: string;
  owner?: string;
  date_from?: string;
  date_to?: string;
  q?: string;
  scope?: string;
  mine?: string;
  cursor?: string;
};

/** 用浏览器路由作为列表状态来源，筛选/分页可刷新、分享和前后回放。 */
export function useResearchBrowseQuery(prefix = "") {
  const [params, setParams] = useSearchParams();
  const get = (key: string, fallback = "") => params.get(`${prefix}${key}`) ?? fallback;
  const patch = (values: Record<string, string>, resetCursor = true) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (resetCursor) next.delete(`${prefix}cursor`);
      Object.entries(values).forEach(([key, value]) => {
        if (value && value !== "all") next.set(`${prefix}${key}`, value);
        else next.delete(`${prefix}${key}`);
      });
      return next;
    });
  };
  const set = (key: string, value: string) => patch({ [key]: value }, key !== "cursor");
  return { params, get, set, patch };
}

/** 组装科研项目与报告共享的浏览请求参数，并合并各领域专属参数。 */
export function researchBrowseRequestParams(
  values: TResearchBrowseCommonValues,
  domain: Record<string, string | undefined>,
  options?: { per_page?: string }
): Record<string, string> {
  const params: Record<string, string> = { per_page: options?.per_page ?? "50" };
  const scope = values.scope?.trim();

  if (values.org_unit) params.org_unit = values.org_unit;
  if (values.owner?.trim()) params.owner = values.owner.trim();
  if (values.date_from) params.date_from = values.date_from;
  if (values.date_to) params.date_to = values.date_to;
  if (values.q) params.q = values.q;
  if (values.cursor) params.cursor = values.cursor;
  if (scope && scope !== "all") params.scope = scope;
  else if (values.mine === "true") params.mine = "true";

  Object.entries(domain).forEach(([key, value]) => {
    if (value) params[key] = value;
  });
  return params;
}

/** 剔除筛选摘要中的空值，保留可直接展示的文本。 */
export function researchFilterSummary(values: Array<string | false | null | undefined>): string[] {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}
