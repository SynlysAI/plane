import { Navigate, useParams, useLocation } from "react-router";

/** 将历史科研审批页签映射为审批中心页面级审批域参数。 */
function legacyApprovalParams(search: string) {
  const source = new URLSearchParams(search);
  const tab = source.get("tab");
  const isResearchQueue = Boolean(tab && tab !== "shared_todos");
  const params = new URLSearchParams();
  params.set("domain", isResearchQueue ? "research" : "shared_todos");
  if (isResearchQueue && tab) params.set("tab", tab);
  for (const [key, value] of source.entries()) {
    if (key !== "domain" && key !== "tab") params.append(key, value);
  }
  return params.toString();
}

export default function LegacyApprovalsPage() {
  const { workspaceSlug } = useParams();
  const { search, hash } = useLocation();
  return <Navigate replace to={`/${workspaceSlug}/approvals?${legacyApprovalParams(search)}${hash}`} />;
}
