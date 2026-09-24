/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import Link from "next/link";
import { useSearchParams } from "react-router";
// plane imports
import { useTranslation } from "@plane/i18n";
// components
import { ResearchApprovalList } from "@/components/research/approvals/approval-list";
import { ResearchAgentApprovalQueue } from "@/components/research/approvals/research-agent-approval-queue";
import { ResearchPageShell } from "@/components/research/common/research-page-shell";
import { ResearchReportList } from "@/components/research/reports/report-list";
import { ReviewInbox } from "@/components/research/reviews/review-inbox";
// hooks
import { useResearch } from "@/hooks/store/use-research";

type Props = {
  workspaceSlug: string;
};

type ApprovalTab = "stage_review" | "report_review" | "agent_approval" | "office";

/**
 * Unified IA v2 approval queues. Each tab still uses its authoritative legacy
 * component and capability; this container only changes presentation.
 */
export const ResearchApprovalCenter = observer(function ResearchApprovalCenter({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get("tab") as ApprovalTab | null;
  const sections = research.identity?.sections;

  if (!research.isIaV2Enabled) {
    return (
      <ResearchPageShell
        titleKey="research.nav.approvals"
        descriptionKey="research.approvals.description"
        section="approvals"
        navKey="approvals"
      >
        <ResearchApprovalList workspaceSlug={workspaceSlug} isAdmin={research.isWorkspaceAdmin} />
      </ResearchPageShell>
    );
  }

  const tabs = [
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
      id: "agent_approval" as const,
      labelKey: "research.approvals.tabs.agent_approval",
      visible: Boolean(sections?.research_agent) && research.canSee("research_chain"),
    },
    {
      id: "office" as const,
      labelKey: "research.approvals.tabs.office",
      visible: Boolean(sections?.approvals) && research.canSee("approvals"),
    },
  ].filter((tab) => tab.visible);
  const activeTab = requestedTab && tabs.some((tab) => tab.id === requestedTab) ? requestedTab : tabs[0]?.id;

  if (!activeTab) {
    return (
      <ResearchPageShell
        titleKey="research.nav.approvals_v2"
        descriptionKey="research.approvals.description"
        section="approvals"
      >
        <p className="p-5 text-13 text-secondary">{t("research.approvals.empty")}</p>
      </ResearchPageShell>
    );
  }

  const shellProps =
    activeTab === "stage_review"
      ? {
          titleKey: "research.nav.approvals_v2",
          descriptionKey: "research.approvals.description",
          section: "stages" as const,
          navKey: "reviews",
        }
      : activeTab === "report_review"
        ? {
            titleKey: "research.nav.approvals_v2",
            descriptionKey: "research.approvals.description",
            section: "reports" as const,
            navKey: "reports",
          }
        : {
            titleKey: "research.nav.approvals_v2",
            descriptionKey: "research.approvals.description",
            section: "approvals" as const,
            navKey: "approvals",
          };

  return (
    <ResearchPageShell {...shellProps}>
      <div className="flex h-full flex-col overflow-hidden">
        <nav
          aria-label={t("research.nav.approvals_v2")}
          className="flex gap-1 overflow-x-auto border-b border-subtle px-5 py-2"
        >
          {tabs.map((tab) => (
            <Link
              key={tab.id}
              href={`/${workspaceSlug}/research/approvals?tab=${tab.id}`}
              aria-current={tab.id === activeTab ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 text-12 whitespace-nowrap transition-colors ${
                tab.id === activeTab ? "bg-surface-2 text-primary" : "text-secondary hover:bg-surface-2"
              }`}
            >
              {t(tab.labelKey)}
            </Link>
          ))}
        </nav>
        <div className="min-h-0 flex-1 overflow-hidden">
          {activeTab === "stage_review" && <ReviewInbox workspaceSlug={workspaceSlug} />}
          {activeTab === "report_review" && <ResearchReportList workspaceSlug={workspaceSlug} variant="review" />}
          {activeTab === "office" && (
            <ResearchApprovalList workspaceSlug={workspaceSlug} isAdmin={research.isWorkspaceAdmin} />
          )}
          {activeTab === "agent_approval" && <ResearchAgentApprovalQueue workspaceSlug={workspaceSlug} />}
        </div>
      </div>
    </ResearchPageShell>
  );
});
