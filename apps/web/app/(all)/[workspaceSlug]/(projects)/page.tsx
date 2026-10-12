/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// components
import { useTranslation } from "@plane/i18n";
import { AppHeader } from "@/components/core/app-header";
import { ContentWrapper } from "@/components/core/content-wrapper";
import { PageHead } from "@/components/core/page-title";
import { WorkspaceHomeView } from "@/components/home";
// hooks
import { useWorkspace } from "@/hooks/store/use-workspace";
// local components
import { WorkspaceDashboardHeader } from "./header";

function WorkspaceDashboardPage() {
  const { currentWorkspace } = useWorkspace();
  const { t } = useTranslation();
  // derived values
  const pageTitle = currentWorkspace?.name ? `${currentWorkspace?.name} - ${t("home.title")}` : undefined;

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      {/* 顶栏高度固定，内容区绝对定位占满剩余视口，避免百分比高度在 flex 收缩后失效。 */}
      <AppHeader className="relative z-[19] shrink-0" header={<WorkspaceDashboardHeader />} />
      <div className="absolute inset-x-0 top-11 bottom-0 overflow-hidden">
        <ContentWrapper>
          <PageHead title={pageTitle} />
          <WorkspaceHomeView />
        </ContentWrapper>
      </div>
    </div>
  );
}

export default observer(WorkspaceDashboardPage);
