import { useEffect, useState } from "react";
import { observer } from "mobx-react";
import { useNavigate } from "react-router";
import { ApproverOutline } from "@makeplane/propel/icons";
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
import { Button } from "@plane/propel/button";
import { EModalWidth, ModalCore } from "@plane/ui";
import { useUserPermissions } from "@/hooks/store/user";
import { ApprovalSubmitForm } from "./approval-submit-form";

export const IssueApprovalButton = observer(function IssueApprovalButton({
  workspaceSlug,
  projectId,
  issueId,
  onOpenChange,
}: {
  workspaceSlug: string;
  projectId: string;
  issueId: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { allowPermissions } = useUserPermissions();
  const allowed = allowPermissions(
    [EUserPermissions.ADMIN, EUserPermissions.MEMBER],
    EUserPermissionsLevel.PROJECT,
    workspaceSlug,
    projectId
  );
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [workspaceSlug, projectId, issueId]);
  useEffect(() => {
    onOpenChange?.(open);
    return () => {
      onOpenChange?.(false);
    };
  }, [open, onOpenChange]);
  if (!allowed) return null;
  return (
    <>
      <Button
        variant="secondary"
        size="lg"
        prependIcon={<ApproverOutline aria-hidden="true" />}
        onClick={() => setOpen(true)}
      >
        发起审批
      </Button>
      <ModalCore isOpen={open} handleClose={() => setOpen(false)} width={EModalWidth.LG}>
        <div className="space-y-4 p-5" data-prevent-outside-click>
          <h2 className="text-16 font-semibold text-primary">发起行政审批</h2>
          <p className="text-12 text-secondary">为当前任务指定审批人，或选择固定审批流程。</p>
          {open && (
            <ApprovalSubmitForm
              workspaceSlug={workspaceSlug}
              projectId={projectId}
              issueId={issueId}
              onSubmitted={(result) => {
                setOpen(false);
                navigate(`/${workspaceSlug}/projects/${projectId}/approvals?request=${result.id}`);
              }}
            />
          )}
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            关闭
          </Button>
        </div>
      </ModalCore>
    </>
  );
});
