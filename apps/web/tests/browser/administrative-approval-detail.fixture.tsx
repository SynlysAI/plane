import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AdministrativeApprovalPanel } from "@/components/administrative/approval-panel";
import { StoreProvider } from "@/lib/store-context";
import { ProjectDomainsService, type TAdministrativeApproval } from "@/services/project-domains.service";
// oxlint-disable-next-line import/no-unassigned-import -- Isolated fixture uses app styles.
import "../../styles/globals.css";

const params = new URLSearchParams(location.search);
const role = params.get("role") || "viewer";
const status = params.get("status") || "PENDING";
const approval: TAdministrativeApproval = {
  id: "request",
  project_id: "project",
  project_name: "公共项目测试",
  issue_id: "issue",
  title: "显微镜采购审批",
  status,
  step: 1,
  flow_id: "flow",
  flow_name: "采购审批流程",
  flow_version: 1,
  approval_mode: "FLOW",
  requester: { id: "requester", display_name: "发起人甲" },
  approvers: status === "PENDING" ? [{ id: "reviewer", display_name: "审批人乙" }] : [],
  can_act: role === "approver" && status === "PENDING",
  can_withdraw: role === "requester" && status === "PENDING",
  can_cancel: role === "manager" && status === "PENDING",
  blocked: false,
  due_at: null,
  created_at: "2026-10-20T02:00:00Z",
  updated_at: "2026-10-20T02:00:00Z",
  work_item: {
    id: "issue",
    workspace_id: "workspace",
    identifier: "ADM-1",
    name: "采购显微镜",
    description_html:
      "<h2>采购申请</h2><p>采购一台显微镜用于实验检测，预算 <strong>30,000 元</strong>。</p><ul><li>用途：材料微观结构分析</li><li>要求：提供报价单及保修说明</li></ul>",
    state: "进行中",
    priority: "high",
    start_date: "2026-10-20",
    target_date: "2026-10-30",
    assignees: [{ id: "owner", display_name: "负责人甲" }],
    attachments: [{ id: "attachment", name: "显微镜采购清单.pdf", url: "/api/assets/attachment/" }],
  },
  steps: [{ order: 1, approver_kind: "USER", approver_name: "审批人乙" }],
  history: [
    {
      id: "submit",
      action: "SUBMIT",
      actor: "发起人甲",
      step: 1,
      comment: "请审核采购用途与预算。",
      created_at: "2026-10-20T02:00:00Z",
    },
  ],
};
ProjectDomainsService.prototype.requests = async () => [approval];
ProjectDomainsService.prototype.getRequest = async (_slug, _id, projectId) => {
  document.body.dataset.detailProject = projectId;
  return approval;
};
ProjectDomainsService.prototype.act = async (_slug, _item, action, comment) => {
  document.body.dataset.action = JSON.stringify({ action, comment });
  approval.status = action === "APPROVE" ? "APPROVED" : action === "REJECT" ? "REJECTED" : "WITHDRAWN";
  approval.can_act = false;
  approval.can_cancel = false;
  approval.can_withdraw = false;
  return approval;
};
createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <MemoryRouter initialEntries={["/?request=request"]}>
      <AdministrativeApprovalPanel workspaceSlug="approval-fixture" projectId="project" />
    </MemoryRouter>
  </StoreProvider>
);
