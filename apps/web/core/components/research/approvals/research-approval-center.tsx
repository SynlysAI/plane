/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useSearchParams } from "react-router";
// plane imports
import { useTranslation } from "@plane/i18n";
import { TabNavigationList } from "@plane/propel/tab-navigation";
import { ResearchTabLink } from "@/components/research/common/research-tab-link";
// components
import { ResearchApprovalList } from "@/components/research/approvals/approval-list";
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { ResearchTodoEnvelopeList } from "@/components/research/common/research-todo-index";
import { ResearchReportList } from "@/components/research/reports/report-list";
import { ReviewInbox } from "@/components/research/reviews/review-inbox";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
};

type ApprovalTab = "shared_todos" | "stage_review" | "report_review" | "office";

type ApprovalShell = {
  titleKey: string;
  descriptionKey: string;
  section: "stages" | "reports" | "approvals";
  navKey: string;
};

/** 构造审批中心 Tab 深链，并保留待办范围等无关 URL 状态。 */
function approvalTabHref(searchParams: URLSearchParams, workspaceSlug: string, tabId: ApprovalTab) {
  const params = new URLSearchParams(searchParams);
  params.set("tab", tabId);
  return `/${workspaceSlug}/research/approvals?${params.toString()}`;
}

/** 按当前队列选择页面门禁，跨组件待办沿用第一个可见领域队列，避免单独被审批开关拦住。 */
function approvalShell(tab: Exclude<ApprovalTab, "shared_todos">): ApprovalShell {
  if (tab === "stage_review") {
    return {
      titleKey: "research.nav.approvals_v2",
      descriptionKey: "research.approvals.description",
      section: "stages",
      navKey: "reviews",
    };
  }
  if (tab === "report_review") {
    return {
      titleKey: "research.nav.approvals_v2",
      descriptionKey: "research.approvals.description",
      section: "reports",
      navKey: "reports",
    };
  }
  return {
    titleKey: "research.nav.approvals_v2",
    descriptionKey: "research.approvals.description",
    section: "approvals",
    navKey: "approvals",
  };
}

/**
 * 审批中心。跨组件待办与领域队列同级，避免聚合列表把阶段评审等页签顶出视口。
 */
export const ResearchApprovalCenter = observer(function ResearchApprovalCenter({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab") as ApprovalTab | null;
  const sections = research.identity?.sections;

  const domainTabs = [
    {
      id: "stage_review" as const,
      labelKey: "research.approvals.tabs.stage_review",
      visible: Boolean(sections?.stages) && research.canSee("reviews"),
    },
    {
      id: "report_review" as const,
      labelKey: "research.approvals.tabs.report_review",
      visible: Boolean(sections?.reports) && research.canSee("reports"),
    },
    {
      id: "office" as const,
      labelKey: "research.approvals.tabs.office",
      visible: Boolean(sections?.approvals) && research.canSee("approvals"),
    },
  ].filter((tab) => tab.visible);
  const tabs = [{ id: "shared_todos" as const, labelKey: "research.approvals.tabs.shared_todos" }, ...domainTabs];
  const activeTab = requestedTab && tabs.some((tab) => tab.id === requestedTab) ? requestedTab : tabs[0].id;

  const shellTab = activeTab === "shared_todos" ? domainTabs[0]?.id : activeTab;
  const shellProps = {
    ...(shellTab ? approvalShell(shellTab) : approvalShell("office")),
    ...(activeTab === "shared_todos" ? { descriptionKey: "research.todo.description_v2" } : {}),
  };

  return (
    <ResearchPageShell {...shellProps}>
      <div className="flex h-full flex-col overflow-hidden">
        <nav
          aria-label={t("research.nav.approvals_v2")}
          className="shrink-0 overflow-x-auto border-b border-subtle px-5"
        >
          <TabNavigationList className="py-2">
            {tabs.map((tab) => (
              <ResearchTabLink
                key={tab.id}
                href={approvalTabHref(searchParams, workspaceSlug, tab.id)}
                isActive={tab.id === activeTab}
              >
                {t(tab.labelKey)}
              </ResearchTabLink>
            ))}
          </TabNavigationList>
        </nav>
        <div className="min-h-0 flex-1 overflow-hidden">
          {activeTab === "shared_todos" && (
            <div className="h-full overflow-y-auto bg-canvas p-5">
              <ResearchTodoEnvelopeList workspaceSlug={workspaceSlug} />
            </div>
          )}
          {activeTab === "stage_review" && <ReviewInbox workspaceSlug={workspaceSlug} />}
          {activeTab === "report_review" && <ResearchReportList workspaceSlug={workspaceSlug} variant="review" />}
          {activeTab === "office" && (
            <ResearchApprovalList workspaceSlug={workspaceSlug} isAdmin={research.isResearchAdmin} />
          )}
        </div>
      </div>
    </ResearchPageShell>
  );
});
