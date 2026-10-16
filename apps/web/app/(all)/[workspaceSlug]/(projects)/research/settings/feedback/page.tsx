import { observer } from "mobx-react";
import { useParams } from "react-router";
// components
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { FeedbackDialog } from "@/components/research/feedback/feedback-dialog";

/** 反馈管理入口，主 PI 按组织树、管理员按工作区范围读取。 */
export default observer(function FeedbackManagementPage() {
  const { workspaceSlug } = useParams();
  if (!workspaceSlug) return null;
  return (
    <ResearchPageShell
      titleKey="research.nav.feedback"
      descriptionKey="research.feedback.management_description"
      allowDisabled
      tabKey="feedback"
    >
      <FeedbackDialog workspaceSlug={workspaceSlug} managementOnly />
    </ResearchPageShell>
  );
});
