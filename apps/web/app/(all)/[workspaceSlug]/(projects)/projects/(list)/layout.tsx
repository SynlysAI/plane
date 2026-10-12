/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { Outlet } from "react-router";
import { useParams } from "next/navigation";
// components
import { AppHeader } from "@/components/core/app-header";
import { ContentWrapper } from "@/components/core/content-wrapper";
import { AdministrativeProjectTabs } from "@/components/administrative/administrative-project-tabs";
import { ProjectsListMobileHeader } from "@/components/projects/mobile-header";
import { ProjectsBaseHeader } from "@/components/project/header";

export default function ProjectListLayout() {
  const { workspaceSlug } = useParams();
  const slug = workspaceSlug?.toString() ?? "";

  return (
    <>
      <AppHeader header={<ProjectsBaseHeader />} mobileHeader={<ProjectsListMobileHeader />} />
      <ContentWrapper>
        <AdministrativeProjectTabs workspaceSlug={slug} activeTab="projects">
          <Outlet />
        </AdministrativeProjectTabs>
      </ContentWrapper>
    </>
  );
}
