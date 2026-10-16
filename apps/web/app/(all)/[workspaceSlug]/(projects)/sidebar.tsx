/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { isEmpty } from "lodash-es";
import { observer } from "mobx-react";
// plane helpers
import { EUserPermissions, EUserPermissionsLevel } from "@plane/constants";
// components
import { SidebarWrapper } from "@/components/sidebar/sidebar-wrapper";
import { SidebarFavoritesMenu } from "@/components/workspace/sidebar/favorites/favorites-menu";
import { SidebarProjectsList } from "@/components/workspace/sidebar/projects-list";
import { SidebarQuickActions } from "@/components/workspace/sidebar/quick-actions";
import { SidebarMenuItems } from "@/components/workspace/sidebar/sidebar-menu-items";
// research
import { ResearchSidebarItems } from "@/components/research/navigation/research-sidebar-items";
// hooks
import { useFavorite } from "@/hooks/store/use-favorite";
import { useResearch } from "@/hooks/store/use-research";
import { useUserPermissions } from "@/hooks/store/user";

export const AppSidebar = observer(function AppSidebar() {
  // store hooks
  const { allowPermissions } = useUserPermissions();
  const { groupedFavorites } = useFavorite();
  const research = useResearch();

  // derived values
  const canPerformWorkspaceMemberActions = allowPermissions(
    [EUserPermissions.ADMIN, EUserPermissions.MEMBER],
    EUserPermissionsLevel.WORKSPACE
  );

  const isFavoriteEmpty = isEmpty(groupedFavorites);
  // IA v2 renders the research and administrative channels through scoped trees.
  const usesResearchProjectTree = research.isEnabled && research.isIaV2Enabled;

  return (
    <SidebarWrapper
      title="Projects"
      quickActions={<SidebarQuickActions />}
      contentLayout={usesResearchProjectTree ? "fill" : "scroll"}
    >
      <SidebarMenuItems />
      {/* Research module entry - additive, hidden when the module is off */}
      <ResearchSidebarItems />
      {/* Favorites Menu */}
      {canPerformWorkspaceMemberActions && !usesResearchProjectTree && !isFavoriteEmpty && <SidebarFavoritesMenu />}
      {/* Projects List */}
      {!usesResearchProjectTree && <SidebarProjectsList />}
    </SidebarWrapper>
  );
});
