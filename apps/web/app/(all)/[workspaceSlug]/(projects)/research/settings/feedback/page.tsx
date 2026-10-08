import { observer } from "mobx-react";
import { useParams } from "react-router";
import { FeedbackDialog } from "@/components/research/feedback/feedback-dialog";
import { ResearchManagementTabs } from "@/components/research/navigation/research-management-tabs";
import { useResearch } from "@/hooks/store/use-research";

/** 反馈管理入口，主 PI 按组织树、管理员按工作区范围读取。 */
export default observer(function FeedbackManagementPage() {
  const { workspaceSlug } = useParams();
  const research = useResearch();
  if (!workspaceSlug) return null;
  const user = research.identity?.user;
  if (!user?.is_main_pi && !user?.is_workspace_admin && !user?.is_system_admin)
    return <p className="p-5 text-13 text-secondary">没有反馈管理权限。</p>;
  return (
    <div className="flex h-full min-w-0 flex-col">
      <ResearchManagementTabs currentKey="feedback" />
      <div className="min-h-0 overflow-auto">
        <FeedbackDialog workspaceSlug={workspaceSlug} managementOnly />
      </div>
    </div>
  );
});
