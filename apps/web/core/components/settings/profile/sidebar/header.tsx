/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
// plane imports
import { Avatar } from "@makeplane/propel/components/avatar";
import { useTranslation } from "@plane/i18n";
import { getFileURL } from "@plane/utils";
import { WorkspaceHomeLink } from "@/components/common/workspace-home-link";
// hooks
import { useUser } from "@/hooks/store/user";

type Props = {
  /** Workspace opened by the caller; omit when no workspace is available. */
  returnWorkspaceSlug?: string;
};

type WorkspaceSlugSource = {
  queryWorkspaceSlug?: string;
  lastWorkspaceSlug?: string;
  fallbackWorkspaceSlug?: string;
  workspaces: Array<{ slug?: string } | undefined>;
};

/**
 * Resolve the profile settings return target without exposing a mixed-workspace tree.
 *
 * Args:
 *   queryWorkspaceSlug: Workspace slug carried by the current profile settings URL.
 *   lastWorkspaceSlug: The user's most recently opened workspace slug.
 *   fallbackWorkspaceSlug: The user's fallback workspace slug.
 *   workspaces: Workspaces currently loaded in the workspace store.
 * Returns:
 *   The preferred available workspace slug, or undefined when no target exists.
 */
export function resolveProfileReturnWorkspaceSlug({
  queryWorkspaceSlug,
  lastWorkspaceSlug,
  fallbackWorkspaceSlug,
  workspaces,
}: WorkspaceSlugSource): string | undefined {
  return (
    queryWorkspaceSlug?.trim() ||
    lastWorkspaceSlug?.trim() ||
    fallbackWorkspaceSlug?.trim() ||
    workspaces.find((workspace) => workspace?.slug?.trim())?.slug?.trim()
  );
}

/** Render the profile settings identity and, when possible, a workspace return entry. */
export const ProfileSettingsSidebarHeader = observer(function ProfileSettingsSidebarHeader({
  returnWorkspaceSlug,
}: Props) {
  // store hooks
  const { data: currentUser } = useUser();
  const { t } = useTranslation();

  return (
    <div className="flex shrink-0 flex-col gap-3">
      <WorkspaceHomeLink
        workspaceSlug={returnWorkspaceSlug}
        label={t("back_to_workspace")}
        className="px-0 hover:bg-transparent"
      />
      <div className="flex items-center gap-2">
        <div className="shrink-0">
          <Avatar
            alt={currentUser?.display_name}
            fallback={currentUser?.display_name?.[0]?.toUpperCase()}
            src={getFileURL(currentUser?.avatar_url ?? "")}
            size="lg"
          />
        </div>
        <div className="truncate">
          <p className="truncate text-body-sm-medium">
            {currentUser?.first_name} {currentUser?.last_name}
          </p>
          <p className="truncate text-caption-md-regular">{currentUser?.email}</p>
        </div>
      </div>
    </div>
  );
});
