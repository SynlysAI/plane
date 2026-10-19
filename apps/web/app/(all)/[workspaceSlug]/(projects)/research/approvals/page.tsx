import { Navigate, useParams, useLocation } from "react-router";
export default function LegacyApprovalsPage() {
  const { workspaceSlug } = useParams();
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search); params.set("domain", "research");
  return <Navigate replace to={`/${workspaceSlug}/approvals?${params}${hash}`} />;
}
