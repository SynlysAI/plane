/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { useCallback, type ComponentType, type SVGProps } from "react";
// hooks
import { useMember } from "@/hooks/store/use-member";
// local imports
import { MemberDropdownBase } from "./base";
import type { MemberDropdownProps } from "./types";

type TMemberDropdownProps = {
  allowClear?: boolean;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  memberIds?: string[];
  onClose?: () => void;
  optionsClassName?: string;
  projectId?: string;
  renderByDefault?: boolean;
} & MemberDropdownProps;

export const MemberDropdown = observer(function MemberDropdown(props: TMemberDropdownProps) {
  const { allowClear = false, memberIds: propsMemberIds, projectId } = props;
  // router params
  const { workspaceSlug } = useParams();
  // store hooks
  const {
    getUserDetails,
    project: { getProjectMemberIds, fetchProjectMembers },
    workspace: { workspaceMemberIds },
  } = useMember();

  const memberIds = propsMemberIds
    ? propsMemberIds
    : projectId
      ? getProjectMemberIds(projectId, false)
      : workspaceMemberIds;

  const onDropdownOpen = useCallback(() => {
    if (projectId && workspaceSlug)
      void fetchProjectMembers(workspaceSlug.toString(), projectId).catch(() => undefined);
  }, [projectId, workspaceSlug, fetchProjectMembers]);

  return (
    <MemberDropdownBase
      {...props}
      allowClear={allowClear}
      getUserDetails={getUserDetails}
      memberIds={memberIds ?? []}
      onDropdownOpen={onDropdownOpen}
      projectId={projectId}
    />
  );
});
