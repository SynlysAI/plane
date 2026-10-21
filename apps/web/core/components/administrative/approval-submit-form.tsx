/**
 * 行政工作项不再通过独立流程发起审批。
 *
 * 负责人保存后立即生效，并由服务端自动完成已有的待审批记录。
 */
export function ApprovalSubmitForm(_props: {
  workspaceSlug: string;
  projectId: string;
  issueId?: string;
  onSubmitted: (approval: unknown) => void;
}) {
  return null;
}
