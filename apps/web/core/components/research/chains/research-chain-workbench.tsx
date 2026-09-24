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
// components
import { ResearchTabLink } from "@/components/research/common/research-tab-link";
import { ResearchChainBoard } from "@/components/research/chains/research-chain-board";
import { ResearchProjectList } from "@/components/research/projects/research-project-list";
import { ResearchReportList } from "@/components/research/reports/report-list";
// hooks
import { useResearch } from "@/hooks/store/use-research";
import { useUser } from "@/hooks/store/user";

type Props = {
  workspaceSlug: string;
};

type ChainView = "chains" | "projects" | "reports";

/**
 * IA v2 Research Chain landing container. Legacy projects and reports remain
 * authoritative objects and are embedded as saved views of the chain surface.
 */
export const ResearchChainWorkbench = observer(function ResearchChainWorkbench({ workspaceSlug }: Props) {
  const { t } = useTranslation();
  const research = useResearch();
  const { data: currentUser } = useUser();
  const [searchParams] = useSearchParams();
  const requestedView = searchParams.get("view") as ChainView | null;

  if (!research.isIaV2Enabled) return <ResearchChainBoard workspaceSlug={workspaceSlug} />;

  const views = [
    { id: "chains" as const, labelKey: "research.chains.views.chains" },
    { id: "projects" as const, labelKey: "research.chains.views.projects" },
    { id: "reports" as const, labelKey: "research.chains.views.reports" },
  ];
  const activeView = requestedView && views.some((view) => view.id === requestedView) ? requestedView : "chains";

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <nav aria-label={t("research.nav.research_chain_v2")} className="overflow-x-auto border-b border-subtle px-5">
        <TabNavigationList className="py-2">
          {views.map((view) => (
            <ResearchTabLink
              key={view.id}
              href={`/${workspaceSlug}/research/chains${view.id === "chains" ? "" : `?view=${view.id}`}`}
              isActive={view.id === activeView}
            >
              {t(view.labelKey)}
            </ResearchTabLink>
          ))}
        </TabNavigationList>
      </nav>
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeView === "chains" && <ResearchChainBoard workspaceSlug={workspaceSlug} />}
        {activeView === "projects" && (
          <ResearchProjectList workspaceSlug={workspaceSlug} currentUserId={currentUser?.id ?? ""} />
        )}
        {activeView === "reports" && <ResearchReportList workspaceSlug={workspaceSlug} />}
      </div>
    </div>
  );
});
