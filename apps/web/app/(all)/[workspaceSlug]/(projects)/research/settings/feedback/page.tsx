import { Navigate, useParams } from "react-router";

/** 将历史科研管理路径统一到工作区管理的反馈页签。 */
export default function FeedbackManagementPage() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;
  return <Navigate replace to={`/${workspaceSlug}/management?tab=feedback`} />;
}
