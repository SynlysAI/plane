import { Navigate, useParams } from "react-router";
export default function LegacyManagementPage() {
  const { workspaceSlug } = useParams();
  return <Navigate replace to={`/${workspaceSlug}/management?tab=research`} />;
}
