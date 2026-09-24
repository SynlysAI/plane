/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect } from "react";
import { observer } from "mobx-react";
import { Navigate, useParams } from "react-router";
// plane imports
import { RESEARCH_SETTINGS_NAVIGATION_ITEMS } from "@plane/constants";
import { Spinner } from "@plane/ui";
// components
import { ResearchStatusPanel } from "@/components/research/common/research-status-panel";
// hooks
import { useResearch } from "@/hooks/store/use-research";

function WorkspaceResearchManagementPage() {
  const { workspaceSlug } = useParams();
  const research = useResearch();

  useEffect(() => {
    if (workspaceSlug && (research.identityWorkspaceSlug !== workspaceSlug || !research.identity))
      void research.fetchIdentity(workspaceSlug).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceSlug]);

  if (!workspaceSlug) return null;
  if (research.identityLoader || research.identityWorkspaceSlug !== workspaceSlug || !research.identity)
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Spinner />
      </div>
    );

  const sections = research.identity.sections;
  const firstTab = RESEARCH_SETTINGS_NAVIGATION_ITEMS.find(
    (item) => Boolean(sections?.[item.section]) && research.canSee(item.key)
  );
  if (!firstTab) return <ResearchStatusPanel status="permission_denied" workspaceSlug={workspaceSlug} />;

  return <Navigate replace to={`/${workspaceSlug}/research/settings/${firstTab.key}`} />;
}

export default observer(WorkspaceResearchManagementPage);
