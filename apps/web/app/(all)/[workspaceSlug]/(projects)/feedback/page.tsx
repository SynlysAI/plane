import { useParams, useSearchParams } from "react-router";
import { FeedbackDialog } from "@/components/research/feedback/feedback-dialog";

/** 为普通成员、运维账号和管理者提供通知可回跳的反馈中心。 */
export default function FeedbackCenterPage() {
  const { workspaceSlug } = useParams();
  const [searchParams] = useSearchParams();
  if (!workspaceSlug) return null;
  const feedbackId = searchParams.get("feedback_id") ?? undefined;
  return (
    <main className="h-full min-w-0 bg-canvas">
      <FeedbackDialog workspaceSlug={workspaceSlug} standalone initialFeedbackId={feedbackId} />
    </main>
  );
}
