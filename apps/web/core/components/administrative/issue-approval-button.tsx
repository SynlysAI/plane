/**
 * 行政工作项不再显示独立审批入口。
 *
 * 负责人保存后立即生效，并由服务端自动完成已有的待审批记录。
 */
export function IssueApprovalButton(_props: {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  onOpenChange?: (open: boolean) => void;
}) {
  return null;
}
