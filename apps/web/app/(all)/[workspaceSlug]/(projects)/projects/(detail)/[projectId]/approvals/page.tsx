import { useParams } from "react-router";
import { AdministrativeApprovalPanel } from "@/components/administrative/approval-panel";
export default function ProjectApprovalsPage() {
  const { workspaceSlug, projectId } = useParams();
  return <div className="h-full overflow-auto bg-surface-1"><h2 className="border-b border-subtle px-5 py-4 text-16 font-medium">项目审批</h2>
    {workspaceSlug && projectId && <AdministrativeApprovalPanel key={`${workspaceSlug}:${projectId}`} workspaceSlug={workspaceSlug} projectId={projectId} />}</div>;
}
