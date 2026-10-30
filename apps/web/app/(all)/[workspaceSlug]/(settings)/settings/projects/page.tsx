/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "react-router";
import { useTheme } from "next-themes";
// plane imports
import { Button } from "@plane/propel/button";
// assets
import ProjectDarkEmptyState from "@/app/assets/empty-state/project-settings/no-projects-dark.png?url";
import ProjectLightEmptyState from "@/app/assets/empty-state/project-settings/no-projects-light.png?url";
import { WorkspaceHomeLink } from "@/components/common/workspace-home-link";
// hooks
import { useCommandPalette } from "@/hooks/store/use-command-palette";

function ProjectSettingsPage() {
  const { workspaceSlug } = useParams();
  // store hooks
  const { resolvedTheme } = useTheme();
  const { toggleCreateProjectModal } = useCommandPalette();
  // derived values
  const resolvedPath = resolvedTheme === "dark" ? ProjectDarkEmptyState : ProjectLightEmptyState;
  return (
    <div className="mx-auto flex h-full max-w-[480px] flex-col items-center justify-center gap-4">
      <div className="flex w-full items-center justify-between gap-3">
        <h1 className="text-22 font-semibold text-primary">项目设置</h1>
        <WorkspaceHomeLink workspaceSlug={workspaceSlug} />
      </div>
      <img src={resolvedPath} alt="No projects yet" />
      <div className="text-16 font-semibold text-tertiary">No projects yet</div>
      <div className="text-center text-13 text-tertiary">
        Projects act as the foundation for goal-driven work. They let you manage your teams, tasks, and everything you
        need to get things done.
      </div>
      <div className="flex gap-2">
        <Button onClick={() => toggleCreateProjectModal(true)}>Start your first project</Button>
      </div>
    </div>
  );
}

export default observer(ProjectSettingsPage);
