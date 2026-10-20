import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { runInAction } from "mobx";
import { MemoryRouter, useLocation } from "react-router";
import { Button } from "@plane/propel/button";
import type { IWorkspaceMemberMe } from "@plane/types";
import { IssueApprovalButton } from "@/components/administrative/issue-approval-button";
import usePeekOverviewOutsideClickDetector from "@/hooks/use-peek-overview-outside-click";
import useKeypress from "@/hooks/use-keypress";
import { StoreProvider, store } from "@/lib/store-context";
import { ProjectDomainsService, type TAdministrativeApproval } from "@/services/project-domains.service";
// oxlint-disable-next-line import/no-unassigned-import -- Browser fixture uses the app's real styles.
import "../../styles/globals.css";

const workspaceSlug = "approval-fixture";
const projectId = "project";
let settingRequests = 0;
ProjectDomainsService.prototype.projectSetting = async () => {
  settingRequests++;
  await new Promise((resolve) => setTimeout(resolve, 300));
  return {
    can_submit: true,
    can_manage: true,
    organization_id: "org",
    flow_id: null,
    approvers: [{ id: "person", name: "审批人甲" }],
  };
};
ProjectDomainsService.prototype.flows = async () => [
  { id: "flow", organization_id: "org", name: "采购审批流程", version: 1, is_active: true, steps: [] },
];
ProjectDomainsService.prototype.submit = async (_slug, _project, issue, selection) => {
  document.body.dataset.submitted = JSON.stringify({ issue, ...selection });
  return { id: "request" } as TAdministrativeApproval;
};
runInAction(() => {
  store.user.permission.workspaceUserInfo[workspaceSlug] = { role: 15 } as IWorkspaceMemberMe;
  store.user.permission.workspaceProjectsPermissions[workspaceSlug] = { [projectId]: 15 };
});

function ApprovalFixture() {
  const [peekOpen, setPeekOpen] = useState(true);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const location = useLocation();
  usePeekOverviewOutsideClickDetector(
    ref,
    () => {
      if (!approvalOpen) setPeekOpen(false);
    },
    "issue"
  );
  useKeypress("Escape", () => {
    if (!approvalOpen) setPeekOpen(false);
  });
  return (
    <main className="h-screen bg-canvas p-6">
      <Button size="xl" onClick={() => setPeekOpen(true)}>
        打开工作项
      </Button>
      <p data-testid="route">
        {location.pathname}
        {location.search}
      </p>
      <p data-testid="requests">{settingRequests}</p>
      {peekOpen && (
        <div
          ref={ref}
          data-testid="peek"
          className="absolute inset-y-0 right-0 w-full max-w-xl border-l border-subtle bg-surface-1 p-5 shadow-raised-200"
        >
          <div className="flex justify-end gap-2">
            <IssueApprovalButton
              workspaceSlug={workspaceSlug}
              projectId={projectId}
              issueId="issue"
              onOpenChange={setApprovalOpen}
            />
            <Button variant="secondary" size="lg">
              订阅
            </Button>
          </div>
          <h1 className="mt-6 text-18">设备采购任务</h1>
        </div>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <MemoryRouter>
      <ApprovalFixture />
    </MemoryRouter>
  </StoreProvider>
);
