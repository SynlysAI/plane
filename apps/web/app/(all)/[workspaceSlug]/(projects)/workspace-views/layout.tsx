/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Outlet } from "react-router";
import { useParams } from "next/navigation";
import { AdministrativeProjectTabs } from "@/components/administrative/administrative-project-tabs";
import { AppHeader } from "@/components/core/app-header";
import { ContentWrapper } from "@/components/core/content-wrapper";
import { GlobalIssuesHeader } from "./header";

export default function GlobalIssuesLayout() {
  const { workspaceSlug } = useParams();
  const slug = workspaceSlug?.toString() ?? "";

  return (
    <>
      <AppHeader header={<GlobalIssuesHeader />} />
      <ContentWrapper>
        <AdministrativeProjectTabs workspaceSlug={slug} activeTab="views">
          <Outlet />
        </AdministrativeProjectTabs>
      </ContentWrapper>
    </>
  );
}
