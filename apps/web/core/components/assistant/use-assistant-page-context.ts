/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
import { useParams, usePathname } from "next/navigation";
// hooks
import { useProject } from "@/hooks/store/use-project";
import { useIssueDetail } from "@/hooks/store/use-issue-detail";
import { useWorkspace } from "@/hooks/store/use-workspace";

/**
 * Compose the current page context the assistant receives with every query.
 * The block is deliberately compact and label-stable so the model can rely
 * on it; the labels stay English regardless of UI locale.
 */
export const useAssistantPageContext = (): string => {
  const params = useParams();
  const pathname = usePathname();
  const workspaceSlug = params?.workspaceSlug?.toString();
  const projectId = params?.projectId?.toString();
  const workItemIdentifier = params?.workItem?.toString();
  const { getWorkspaceBySlug } = useWorkspace();
  const { getProjectById } = useProject();
  const { peekIssue } = useIssueDetail();

  return useMemo(() => {
    if (!workspaceSlug) return "";
    const lines: string[] = [];
    const workspace = getWorkspaceBySlug(workspaceSlug);
    lines.push(`workspace: ${workspace?.name ?? workspaceSlug} (${workspaceSlug})`);
    if (projectId) {
      const project = getProjectById(projectId);
      if (project) lines.push(`project: ${project.name} (${project.identifier})`);
    }
    if (workItemIdentifier) lines.push(`viewing work item: ${workItemIdentifier}`);
    else if (peekIssue?.issueId) lines.push(`peeking work item: ${peekIssue.issueId}`);
    if (pathname) lines.push(`page: ${pathname}`);
    return lines.length > 1 ? `[Page context]\n${lines.join("\n")}` : "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug, projectId, workItemIdentifier, peekIssue?.issueId, pathname]);
};
