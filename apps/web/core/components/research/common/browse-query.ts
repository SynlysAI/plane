import { useSearchParams } from "react-router";

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
